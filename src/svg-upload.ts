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
): Promise<{ ok: boolean; status: number; data: any }> {
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

  const data = res.ok ? await res.json() : null;
  return { ok: res.ok, status: res.status, data };
}

// ── Branch management ───────────────────────────────────────

/** Ensure the assets branch exists. Returns the tip commit SHA. */
async function ensureBranch(token: string): Promise<string> {
  const ref = await ghApi(token, 'GET', `/git/ref/heads/${BRANCH}`);
  if (ref.ok) return ref.data.object.sha;

  // Create orphan branch with empty tree
  const tree = await ghApi(token, 'POST', '/git/trees', { tree: [] });
  if (!tree.ok) throw new Error(`Failed to create tree: ${tree.status}`);

  const commit = await ghApi(token, 'POST', '/git/commits', {
    message: 'Initialize RunnerLens assets branch',
    tree: tree.data.sha,
    parents: [],
  });
  if (!commit.ok) throw new Error(`Failed to create commit: ${commit.status}`);

  const newRef = await ghApi(token, 'POST', '/git/refs', {
    ref: `refs/heads/${BRANCH}`,
    sha: commit.data.sha,
  });
  // 422 means another job created it first — that's fine
  if (!newRef.ok && newRef.status !== 422) {
    throw new Error(`Failed to create branch: ${newRef.status}`);
  }
  // Re-read the ref to get the actual tip SHA
  if (!newRef.ok) {
    const retry = await ghApi(token, 'GET', `/git/ref/heads/${BRANCH}`);
    if (retry.ok) return retry.data.object.sha;
    throw new Error('Failed to read branch after creation');
  }
  return commit.data.sha;
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
    // Create blobs for all SVGs in parallel
    const blobResults = await Promise.all(
      entries.map(([, svg]) =>
        ghApi(token, 'POST', '/git/blobs', { content: svg, encoding: 'utf-8' }),
      ),
    );
    for (const b of blobResults) {
      if (!b.ok) throw new Error(`Blob creation failed: ${b.status}`);
    }

    // Commit & push with retry (handles concurrent updates from parallel jobs)
    for (let attempt = 0; attempt < 3; attempt++) {
      const tipSha = await ensureBranch(token);

      const tipCommit = await ghApi(token, 'GET', `/git/commits/${tipSha}`);
      if (!tipCommit.ok) throw new Error(`Failed to get tip commit: ${tipCommit.status}`);

      const treeItems = entries.map(([name], i) => ({
        path: `${subdir}/${name}.svg`,
        mode: '100644',
        type: 'blob',
        sha: blobResults[i].data.sha,
      }));

      const newTree = await ghApi(token, 'POST', '/git/trees', {
        base_tree: tipCommit.data.tree.sha,
        tree: treeItems,
      });
      if (!newTree.ok) throw new Error(`Tree creation failed: ${newTree.status}`);

      const newCommit = await ghApi(token, 'POST', '/git/commits', {
        message: `RunnerLens: charts for run #${runId} (${jobName})`,
        tree: newTree.data.sha,
        parents: [tipSha],
      });
      if (!newCommit.ok) throw new Error(`Commit creation failed: ${newCommit.status}`);

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

      // Ref update failed (concurrent push) — retry after brief delay
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
