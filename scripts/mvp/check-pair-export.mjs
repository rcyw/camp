import { randomUUID } from 'node:crypto';

/** Run the physical exported files, without network, credentials or a Store. */
export async function checkPairExport({ runtime, imageId, output, harnessPath }) {
  if ([output, harnessPath].some(path => !path.startsWith('/') || /[,\r\n]/.test(path))) throw new Error('Export check requires absolute Docker mount paths without separators');
  const checks = [];
  for (const argv of [['node', '--test'], ['node', '/camp-checks/pair-contract']]) {
    const name = 'camp-pair-export-check-' + randomUUID();
    try {
      // Exports preserve modes and host ownership, including a private 0700
      // root. This separate artifact check reads that root as UID 0, with no
      // capabilities and only readonly source/harness binds. Product candidate
      // verification continues to run as UID 501 in fresh tmpfs copies.
      const result = await runtime.dockerCall(['run', '--rm', '--name', name, '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '536870912', '--memory-swap', '536870912', '--cpus', '1', '--log-driver', 'none', '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864,mode=0700', '--mount', `type=bind,source=${output},target=/workspace,readonly`, '--mount', `type=bind,source=${harnessPath},target=/camp-checks/pair-contract,readonly`, '--workdir', '/workspace', '--entrypoint', argv[0], imageId, ...argv.slice(1)], { timeout: 60000, maxBuffer: 65536 });
      checks.push({ argv, executionUid: 0, exitCode: 0, testsPassed: argv.includes('--test') ? /(?:#|ℹ) pass 4\b/.test(result.stdout) : /Both independently implemented modules passed/.test(result.stdout) });
    } finally {
      await runtime.dockerCall(['rm', '--force', name], { timeout: 5000 }).catch(error => { if (!/No such container/i.test(error.stderr ?? '')) throw error; });
    }
  }
  if (checks.some(check => !check.testsPassed)) throw new Error('Exported pair did not produce the expected independent check evidence');
  return checks;
}
