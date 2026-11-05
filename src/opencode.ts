/**
 * OpenCode CLI 连接器
 * 调用本机已安装的 opencode CLI，用它配置好的供应商/账号跑任务
 * 参考：agency-orchestrator/src/connectors/opencode-cli.ts
 */
import { spawn } from 'node:child_process';

export interface OpencodeResult {
  text: string;
  error?: string;
  durationMs: number;
}

/**
 * 解析 opencode --format json 的 NDJSON 输出
 * 答案在 type=="text" 事件的 part.text，多段按顺序拼接
 */
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

/**
 * 调用 opencode run
 * @param systemPrompt 角色设定（走 stdin 传入）
 * @param userMessage 用户消息 / 任务
 * @param projectDir 项目目录（--dir 参数，opencode 会在这个目录下工作）
 */
export async function runOpencode(
  systemPrompt: string,
  userMessage: string,
  projectDir: string
): Promise<OpencodeResult> {
  const start = Date.now();

  return new Promise((resolve) => {
    // opencode run --format json --dir <目录> "<消息>"
    // system prompt 走 stdin，用 <system>...</system> 包装
    const args = ['run', '--format', 'json', '--dir', projectDir, userMessage];
    
    const proc = spawn('opencode', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      const durationMs = Date.now() - start;
      if (code !== 0) {
        resolve({
          text: '',
          error: `opencode 退出码 ${code}: ${stderr.slice(0, 500)}`,
          durationMs,
        });
        return;
      }
      const text = parseNdjson(stdout);
      resolve({ text, durationMs });
    });

    proc.on('error', (err) => {
      resolve({
        text: '',
        error: `无法启动 opencode: ${err.message}（请确认已安装并配置好：npm install -g opencode-ai && opencode auth login）`,
        durationMs: Date.now() - start,
      });
    });

    // 把 system prompt 通过 stdin 传入，写完就关
    // 照 agency-orchestrator 的方式：<system>...</system> 包装
    const stdinContent = `<system>\n${systemPrompt}\n</system>\n\n请按以上角色设定回答下面的问题，直接输出结果：`;
    proc.stdin.write(stdinContent);
    proc.stdin.end(); // 必须 end，否则 opencode 会一直等
  });
}

/**
 * 检查 opencode 是否可用（快速测试）
 */
export async function checkOpencode(): Promise<{ ok: boolean; version?: string; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn('opencode', ['--version'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, version: out.trim() });
      } else {
        resolve({ ok: false, error: 'opencode 未安装或不可用' });
      }
    });
    proc.on('error', () => {
      resolve({ ok: false, error: 'opencode 未安装' });
    });
  });
}
