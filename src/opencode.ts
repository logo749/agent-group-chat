/**
 * OpenCode CLI 连接器
 * 调用本机已安装的 opencode CLI，用它配置好的供应商/账号跑任务
 */
import { spawn } from 'node:child_process';

export interface OpencodeResult {
  text: string;
  error?: string;
  durationMs: number;
}

function log(...args: any[]) {
  console.log('[opencode]', ...args);
}
function logError(...args: any[]) {
  console.error('[opencode 错误]', ...args);
}

function parseNdjson(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const obj = JSON.parse(s);
      if (obj?.type === 'text' && typeof obj.part?.text === 'string') {
        parts.push(obj.part.text);
      }
    } catch {
      // 跳过非 JSON 行
    }
  }
  return parts.join('').trim();
}

const SPAWN_OPTS = {
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  shell: true,
};

export async function runOpencode(
  systemPrompt: string,
  userMessage: string,
  projectDir: string
): Promise<OpencodeResult> {
  const start = Date.now();

  return new Promise((resolve) => {
    const cmd = `opencode run --format json --dir "${projectDir}" "${userMessage.replace(/"/g, '\\"')}"`;
    log(`执行命令: ${cmd.slice(0, 120)}${cmd.length > 120 ? '...' : ''}`);

    const proc = spawn(cmd, SPAWN_OPTS);

    let stdout = '';
    let stderr = '';
    let stderrLines = 0;

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      stderrLines++;
      // 打印前几行 stderr，方便调试
      if (stderrLines <= 5) {
        log(`stderr: ${chunk.trim().slice(0, 200)}`);
      }
    });

    proc.on('close', (code) => {
      const durationMs = Date.now() - start;
      log(`进程退出，code=${code}，耗时 ${durationMs}ms，stdout=${stdout.length}字符，stderr=${stderr.length}字符`);

      if (code !== 0) {
        logError(`退出码 ${code}，stderr 前500字: ${stderr.slice(0, 500)}`);
        resolve({
          text: '',
          error: `opencode 退出码 ${code}: ${stderr.slice(0, 300)}`,
          durationMs,
        });
        return;
      }

      const text = parseNdjson(stdout);
      if (!text) {
        logError(`stdout 里没有 text 事件，原始输出前300字: ${stdout.slice(0, 300)}`);
      }
      resolve({ text, durationMs });
    });

    proc.on('error', (err) => {
      logError(`无法启动进程: ${err.message}`);
      resolve({
        text: '',
        error: `无法启动 opencode: ${err.message}（请确认已安装并配置好：npm install -g opencode-ai && opencode auth login）`,
        durationMs: Date.now() - start,
      });
    });

    // system prompt 走 stdin
    const stdinContent = `<system>\n${systemPrompt}\n</system>\n\n请按以上角色设定回答下面的问题，直接输出结果：`;
    proc.stdin.write(stdinContent);
    proc.stdin.end();
  });
}

export async function checkOpencode(): Promise<{ ok: boolean; version?: string; error?: string }> {
  const commands = [
    'opencode --version',
    'opencode -v',
    'which opencode',
  ];

  for (const cmd of commands) {
    const result = await tryCommand(cmd);
    if (result.ok) {
      return { ok: true, version: result.output.trim() };
    }
  }

  return { ok: false, error: 'opencode 未找到，请确认已安装并在 PATH 中' };
}

function tryCommand(cmd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, { ...SPAWN_OPTS, timeout: 3000 });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0 && out.trim()) {
        resolve({ ok: true, output: out });
      } else {
        resolve({ ok: false, output: out || err });
      }
    });
    proc.on('error', () => resolve({ ok: false, output: '' }));
  });
}
