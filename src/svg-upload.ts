// ─────────────────────────────────────────────────────────────
// RunnerLens — SVG Chart Upload
//
// Uploads SVG chart files to a dedicated branch in the repository
// so they can be referenced via <img> tags in GitHub Job Summary.
// GitHub strips inline SVGs and data URIs from Job Summary, but
// renders <img> tags pointing to https:// URLs.
// ─────────────────────────────────────────────────────────────

import * as core from '@actions/core';

const BRANCH = 'runner-lens-assets';

// ── GitHub API helper ───────────────────────────────────────

async function ghApi(
  token: string,
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: any; message?: string }> {
  const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY not set');

  const url = `${apiUrl}/repos/${repo}${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let data: any = null;
  let message: string | undefined;
  try {
    data = await res.json();
    if (!res.ok) {
      message = data?.message ?? `HTTP ${res.status}`;
    }
  } catch {
    if (!res.ok) message = `HTTP ${res.status}`;
  }
  return { ok: res.ok, status: res.status, data, message };
}

// ── Branch management ───────────────────────────────────────

/**
 * Get the tip commit SHA of the assets branch, or null if it doesn't exist.
 */
async function getBranchTip(token: string): Promise<string | null> {
  const ref = await ghApi(token, 'GET', `/git/ref/heads/${BRANCH}`);
  if (ref.ok) return ref.data.object.sha;
  return null;
}

/**
 * Create the assets branch as an orphan with the given tree SHA.
 * Returns true if created (or already exists from a concurrent job).
 */
async function createBranch(token: string, commitSha: string): Promise<boolean> {
  const newRef = await ghApi(token, 'POST', '/git/refs', {
    ref: `refs/heads/${BRANCH}`,
    sha: commitSha,
  });
  // 422 means another job created it first — that's fine
  return newRef.ok || newRef.status === 422;
}

// ── Upload ──────────────────────────────────────────────────

/**
 * Upload SVG charts to the runner-lens-assets branch.
 * Returns a map of chart name → raw URL for <img> tags.
 */
export async function uploadChartSvgs(
  charts: Record<string, string>,
  token: string,
): Promise<Record<string, string>> {
  const urls: Record<string, string> = {};
  const entries = Object.entries(charts);
  if (!token || entries.length === 0) return urls;

  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const jobName = process.env.GITHUB_JOB ?? 'job';
  if (!repo || !runId) return urls;

  const subdir = `runs/${runId}/${jobName}`;
  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const rawBase = serverUrl === 'https://github.com'
    ? `https://raw.githubusercontent.com/${repo}`
    : `${serverUrl}/${repo}/raw`;

  try {
    // Create blobs for all SVGs in parallel (base64 for reliability)
    const blobResults = await Promise.all(
      entries.map(([, svg]) =>
        ghApi(token, 'POST', '/git/blobs', {
          content: Buffer.from(svg, 'utf-8').toString('base64'),
          encoding: 'base64',
        }),
      ),
    );
    for (const b of blobResults) {
      if (!b.ok) throw new Error(`Blob creation failed: ${b.status} — ${b.message}`);
    }

    const treeItems = entries.map(([name], i) => ({
      path: `${subdir}/${name}.svg`,
      mode: '100644' as const,
      type: 'blob' as const,
      sha: blobResults[i].data.sha as string,
    }));

    // Commit & push with retry (handles concurrent updates from parallel jobs)
    for (let attempt = 0; attempt < 3; attempt++) {
      const tipSha = await getBranchTip(token);

      let treeSha: string;
      if (tipSha) {
        // Branch exists — merge our files into the existing tree
        const tipCommit = await ghApi(token, 'GET', `/git/commits/${tipSha}`);
        if (!tipCommit.ok) throw new Error(`Failed to get tip commit: ${tipCommit.status}`);

        const newTree = await ghApi(token, 'POST', '/git/trees', {
          base_tree: tipCommit.data.tree.sha,
          tree: treeItems,
        });
        if (!newTree.ok) throw new Error(`Tree creation failed: ${newTree.status} — ${newTree.message}`);
        treeSha = newTree.data.sha;
      } else {
        // Branch doesn't exist — create tree from scratch (no base_tree)
        const newTree = await ghApi(token, 'POST', '/git/trees', { tree: treeItems });
        if (!newTree.ok) throw new Error(`Tree creation failed: ${newTree.status} — ${newTree.message}`);
        treeSha = newTree.data.sha;
      }

      const newCommit = await ghApi(token, 'POST', '/git/commits', {
        message: `RunnerLens: charts for run #${runId} (${jobName})`,
        tree: treeSha,
        parents: tipSha ? [tipSha] : [],
      });
      if (!newCommit.ok) throw new Error(`Commit creation failed: ${newCommit.status} — ${newCommit.message}`);

      if (tipSha) {
        // Update existing branch ref
        const update = await ghApi(token, 'PATCH', `/git/refs/heads/${BRANCH}`, {
          sha: newCommit.data.sha,
        });
        if (update.ok) {
          for (const [name] of entries) {
            urls[name] = `${rawBase}/${BRANCH}/${subdir}/${name}.svg`;
          }
          core.info(`RunnerLens: uploaded ${entries.length} chart(s) to ${BRANCH} branch`);
          return urls;
        }
        // Ref update failed (concurrent push) — retry
      } else {
        // Create new branch with this commit
        const created = await createBranch(token, newCommit.data.sha);
        if (created) {
          for (const [name] of entries) {
            urls[name] = `${rawBase}/${BRANCH}/${subdir}/${name}.svg`;
          }
          core.info(`RunnerLens: created ${BRANCH} branch with ${entries.length} chart(s)`);
          return urls;
        }
        // Another job created the branch — retry with base_tree merge
      }

      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
      }
    }

    core.warning('RunnerLens: chart upload failed after 3 attempts (concurrent updates)');
  } catch (e) {
    core.warning(`RunnerLens: chart upload failed — ${e}`);
  }

  return urls;
}
