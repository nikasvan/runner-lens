// Pre-cache mocks for GitHub Actions modules
const Module = require('module');
const origResolve = Module._resolveFilename;
const mocks = {
  '@actions/core': { info(){}, warning(){}, debug(){}, getInput(){return ''}, setOutput(){}, getState(){return ''}, saveState(){}, summary: { addRaw(){ return { write: async()=>{} } } } },
  '@actions/artifact': { DefaultArtifactClient: class {} },
  '@actions/github': { context: { repo: { owner: 'test', repo: 'test' }, runId: 1, sha: 'abc123' } },
};
Module._resolveFilename = function(request, parent, isMain, options) {
  if (mocks[request]) return request;
  return origResolve.call(this, request, parent, isMain, options);
};
const origLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (mocks[request]) return mocks[request];
  return origLoad.call(this, request, parent, isMain);
};

require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs', esModuleInterop: true, resolveJsonModule: true } });

const { workflowMarkdown } = require('./src/summary');

function makeReport(name, startMin, dur, cpu, mem) {
  const t0 = new Date(`2024-11-14T22:${String(startMin).padStart(2,'0')}:00Z`);
  const cpuA = cpu.reduce((a,b)=>a+b,0)/cpu.length;
  const memA = mem.reduce((a,b)=>a+b,0)/mem.length;
  const steps = name==='build' ? [
    {name:'Checkout',number:1,duration_seconds:8,cpu_avg:15,cpu_max:30,mem_avg_mb:800,mem_max_mb:1000,sample_count:3},
    {name:'Setup Node.js',number:2,duration_seconds:15,cpu_avg:20,cpu_max:40,mem_avg_mb:900,mem_max_mb:1100,sample_count:5},
    {name:'Install deps',number:3,duration_seconds:52,cpu_avg:45,cpu_max:70,mem_avg_mb:1800,mem_max_mb:2500,sample_count:17},
    {name:'Build',number:4,duration_seconds:205,cpu_avg:72,cpu_max:97,mem_avg_mb:3200,mem_max_mb:4800,sample_count:68},
  ] : name==='lint' ? [
    {name:'Checkout',number:1,duration_seconds:6,cpu_avg:12,cpu_max:25,mem_avg_mb:700,mem_max_mb:900,sample_count:2},
    {name:'Setup Node.js',number:2,duration_seconds:12,cpu_avg:18,cpu_max:35,mem_avg_mb:850,mem_max_mb:1050,sample_count:4},
    {name:'Lint',number:3,duration_seconds:77,cpu_avg:55,cpu_max:78,mem_avg_mb:2200,mem_max_mb:3100,sample_count:26},
  ] : [
    {name:'Checkout',number:1,duration_seconds:7,cpu_avg:14,cpu_max:28,mem_avg_mb:750,mem_max_mb:950,sample_count:2},
    {name:'Setup Node.js',number:2,duration_seconds:14,cpu_avg:19,cpu_max:38,mem_avg_mb:880,mem_max_mb:1080,sample_count:5},
    {name:'Install deps',number:3,duration_seconds:48,cpu_avg:40,cpu_max:65,mem_avg_mb:1700,mem_max_mb:2400,sample_count:16},
    {name:'Run tests',number:4,duration_seconds:141,cpu_avg:68,cpu_max:95,mem_avg_mb:3500,mem_max_mb:4900,sample_count:47},
  ];
  return {
    version:'1.0.0',
    system:{cpu_count:2,cpu_model:'AMD EPYC 7763',total_memory_mb:7168,os_release:'Ubuntu 22.04.3 LTS',kernel:'6.2.0',runner_name:'GitHub Actions 2',runner_os:'Linux',runner_arch:'X64'},
    duration_seconds:dur, sample_count:cpu.length,
    started_at:t0.toISOString(), ended_at:new Date(t0.getTime()+dur*1000).toISOString(),
    cpu:{avg:cpuA,max:Math.max(...cpu),min:Math.min(...cpu),p50:cpuA,p95:Math.max(...cpu)*0.95,p99:Math.max(...cpu)*0.99,latest:cpu[cpu.length-1]},
    memory:{avg:memA,max:Math.max(...mem),min:Math.min(...mem),p50:memA,p95:Math.max(...mem)*0.95,p99:Math.max(...mem)*0.99,latest:mem[mem.length-1],total_mb:7168,swap_max_mb:0},
    load:{avg_1m:1.5,max_1m:3.2}, top_processes:[], timeline:{cpu_pct:cpu,mem_mb:mem}, steps,
  };
}

function gen(n, fn) { const v=[]; for(let i=0;i<n;i++) v.push(fn(i)); return v; }

const jobs = [
  { jobName:'build', report: makeReport('build',0,280,
    gen(80,i=> i<8 ? 15+Math.sin(i*0.5)*10 : i<25 ? 30+Math.sin(i*0.3)*15 : 50+Math.sin(i*0.15)*25+Math.random()*10),
    gen(80,i=> 800+i*35+Math.sin(i*0.2)*200)) },
  { jobName:'lint', report: makeReport('lint',5,95,
    gen(36,i=> i<6 ? 10+Math.random()*12 : 25+Math.sin(i*0.4)*20+Math.random()*10),
    gen(36,i=> 700+i*65+Math.sin(i*0.3)*150)) },
  { jobName:'test', report: makeReport('test',6,210,
    gen(70,i=> i<7 ? 12+Math.random()*15 : i<23 ? 22+Math.sin(i*0.4)*12 : 45+Math.sin(i*0.12)*30+Math.random()*12),
    gen(70,i=> 750+i*50+Math.sin(i*0.15)*250)) },
];

const cfg = {mode:'summarize',sampleInterval:3,summaryStyle:'full',maxSizeMb:100,apiKey:'',apiEndpoint:'',githubToken:''};
const md = workflowMarkdown(jobs, cfg);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="color-scheme" content="dark">
<title>RunnerLens — Workflow Summary Preview</title>
<style>
  body { background:#0d1117; color:#e6edf3; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; max-width:720px; margin:40px auto; padding:0 20px; line-height:1.6; }
  h2,h3 { border-bottom:1px solid #21262d; padding-bottom:8px; }
  a { color:#58a6ff; } sub { color:#8b949e; }
  svg, img { max-width:100%; height:auto; display:block; margin:12px 0; }
  hr { border:none; border-top:1px solid #21262d; margin:16px 0; }
</style>
</head>
<body>
${md}
</body>
</html>`;

require('fs').writeFileSync('/mnt/user-data/outputs/preview-workflow-summary.html', html);
console.log('Done! Preview written to outputs.');
