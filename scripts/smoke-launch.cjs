// This manual smoke test activates Codex and opens an official Claude Code terminal.
// It does not change client configuration or send an inference prompt.
const {launchCodexDesktop,launchClaudeTerminal}=require('../dist/main/detection.js');
const path=require('node:path');
const fs=require('node:fs');
const {resolveClaudeCommand}=require('./runtime-paths.cjs');
(async()=>{
  const codex=await launchCodexDesktop('');
  console.log(JSON.stringify({engine:'codex',...codex}));
  const fixture=path.resolve(__dirname,'../.qa/launch-repair');
  const project=path.join(fixture,'project');
  fs.mkdirSync(project,{recursive:true});
  const claude=await launchClaudeTerminal(resolveClaudeCommand(),project,fixture);
  console.log(JSON.stringify({engine:'claude',...claude}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
