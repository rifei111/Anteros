/**
 * 网络层的小修：把 Windows 系统根证书并入 Node 的默认信任链。
 *
 * 为什么需要：本机若装了公司/安全软件的 TLS 中间人代理（或用了本地根证书），
 * Node 只认自带的 Mozilla 根证书，`fetch` 会直接报
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE`。命令行可以加 `--use-system-ca`，
 * 但我们跑的是被打包的应用进程，没地方加参数，只能在运行时把系统根证书合并进来。
 *
 * 只影响「信任哪些根证书」，不跳过校验、也不关闭 TLS。
 */
import { getCACertificates, setDefaultCACertificates } from "node:tls";

let installed = false;

export interface CertificateSink {
  debug?(message: string): void;
  warn?(message: string): void;
}

/**
 * 幂等：进程内只装一次。失败也不抛，最多是不合并（和以前行为一致）。
 */
export function useSystemCertificates(log?: CertificateSink): void {
  if (installed) return;
  installed = true;
  try {
    const system = getCACertificates("system");
    if (system.length === 0) {
      log?.debug?.("系统根证书为空，沿用 Node 自带根证书");
      return;
    }
    setDefaultCACertificates([...getCACertificates("default"), ...system]);
    log?.debug?.(`已并入系统根证书 ${system.length} 张（本机 TLS 代理需要）`);
  } catch (error) {
    log?.warn?.(`合并系统根证书失败，沿用 Node 自带根证书：${error instanceof Error ? error.message : String(error)}`);
  }
}
