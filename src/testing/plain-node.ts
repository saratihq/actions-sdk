import { execFile } from 'node:child_process';

const TYPESCRIPT = require.resolve('typescript');

/** Run `script` (CommonJS that may `require` the SDK's .ts sources) in a plain Node process, outside Jest's module realm; resolves with its stdout. */
export function runInPlainNode(script: string, env: Record<string, string> = {}): Promise<string> {
  const hook = `
    const ts = require(${JSON.stringify(TYPESCRIPT)});
    const fs = require('node:fs');
    require.extensions['.ts'] = (module, filename) => {
      const source = fs.readFileSync(filename, 'utf8');
      const options = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true };
      module._compile(ts.transpileModule(source, { compilerOptions: options, fileName: filename }).outputText, filename);
    };
  `;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['-e', `${hook}\n${script}`],
      { env: { ...process.env, NODE_OPTIONS: '', ...env } },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)),
    );
  });
}
