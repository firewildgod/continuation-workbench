// Offline only: the mock server emits fixed tool instructions, never forwards.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { runCLI, isolatedEnvironment } = require('./verify-claude-live.cjs');
const { resolveClaudeCommand } = require('./runtime-paths.cjs');
const qa = path.resolve(__dirname, '..', '.qa', 'v0.2-user');
const settingsDir = path.join(qa, 'offline-claude');
const sampleDir = path.join(qa, 'offline-project');
fs.mkdirSync(settingsDir, { recursive: true }); fs.mkdirSync(sampleDir, { recursive: true });
const text = 'OFFLINE-CLI-TOOL-QA\n';
fs.writeFileSync(path.join(sampleDir, 'note.txt'), text);
const oldResult = path.join(sampleDir, 'result.txt');
if (fs.existsSync(oldResult)) fs.unlinkSync(oldResult); // Exact QA-owned single file.
const report = { paidRequests: 0, pass: false, toolResults: [], allowedWriteRule: 'Edit(./result.txt)' };
let count = 0;
const server = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { response.writeHead(400); response.end('{}'); return; }
  if (!request.url.startsWith('/v1/messages')) { response.writeHead(404); response.end('{}'); return; }
  const step = ++count;
  const content = step === 1 ? { type: 'tool_use', id: 'offline_read', name: 'Read', input: { file_path: path.join(sampleDir, 'note.txt') } }
    : step === 2 ? { type: 'tool_use', id: 'offline_write', name: 'Write', input: { file_path: path.join(sampleDir, 'result.txt'), content: text } }
    : { type: 'text', text: 'DONE' };
  const stop = step <= 2 ? 'tool_use' : 'end_turn';
  const message = { id: `offline_${step}`, type: 'message', role: 'assistant', model: 'qwen3.8-flash', content: [content], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 5 } };
  if (!body.stream) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(message)); return; }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  emit('message_start', { message: { ...message, content: [], stop_reason: null } });
  emit('content_block_start', { index: 0, content_block: content.type === 'tool_use' ? { ...content, input: {} } : { type: 'text', text: '' } });
  emit('content_block_delta', { index: 0, delta: content.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } : { type: 'text_delta', text: content.text } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  emit('message_stop', {}); response.end();
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = isolatedEnvironment(settingsDir, sampleDir);
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  env.ANTHROPIC_AUTH_TOKEN = 'a'.repeat(64);
  const settingsFile = path.join(settingsDir, 'settings.json'); fs.writeFileSync(settingsFile, JSON.stringify({ env }));
  const result = await runCLI(resolveClaudeCommand(), ['-p', 'Read note.txt, then write result.txt with the same contents.', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', 'user', '--settings', settingsFile, '--model', 'qwen3.8-flash', '--max-turns', '3', '--tools', 'Read,Write', '--allowedTools', 'Read(./note.txt)', 'Edit(./result.txt)', '--permission-mode', 'dontAsk'], sampleDir, env, 30000);
  for (const line of result.stdout.split(/\r?\n/)) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    for (const block of event.message?.content || []) if (block.type === 'tool_result') {
      const content = typeof block.content === 'string' ? block.content : '';
      report.toolResults.push({ tool: block.tool_use_id === 'offline_read' ? 'Read' : block.tool_use_id === 'offline_write' ? 'Write' : 'unknown', error: block.is_error === true, permissionDenied: /permission|not allowed|denied|approval/i.test(content) });
    }
  }
  report.exitCode = result.exitCode; report.mockRequests = count;
  report.resultFileExists = fs.existsSync(path.join(sampleDir, 'result.txt'));
  report.pass = report.resultFileExists && fs.readFileSync(path.join(sampleDir, 'result.txt'), 'utf8') === text;
})().catch(() => { report.failure = 'Offline test error; sensitive detail suppressed'; }).finally(async () => {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(qa, 'claude-offline-report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report)); process.exitCode = report.pass ? 0 : 1;
});
