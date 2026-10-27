/**
 * 插件运行环境：整包安装、按文件增量升级、校验失败回滚、卸载。
 *
 * 全部走本机 http 服务（127.0.0.1 随机端口），不放外网、不用 mock 网关：
 * 下载、sha256 校验、tar.gz 解包、原子切换都是真跑。
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginRuntimeManager, untar } from "../src/plugins/runtime.js";

const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 写一个最小 tar（ustar），只放普通文件与目录。 */
function makeTar(entries: Array<{ path: string; data?: string; dir?: boolean }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const name = entry.path;
    const data = entry.dir === true ? Buffer.alloc(0) : Buffer.from(entry.data ?? "", "utf8");
    const header = Buffer.alloc(512, 0);
    header.write(name.slice(0, 100), 0, "utf8");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.write("        ", 148, "ascii");
    header.write(entry.dir === true ? "5" : "0", 156, "ascii");
    header.write("ustar\0" + "00", 257, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    blocks.push(header);
    if (data.length > 0) {
      blocks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad > 0) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

interface FeedServer {
  baseUrl: string;
  hits: string[];
  close(): Promise<void>;
}

async function serveFeed(routes: Map<string, Buffer | string>): Promise<FeedServer> {
  const hits: string[] = [];
  const server: Server = createServer((request, response) => {
    const url = request.url ?? "/";
    hits.push(url);
    const body = routes.get(url);
    if (body === undefined) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", typeof body === "string" ? "application/json" : "application/octet-stream");
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("起不了本机 http 服务");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let rootDir: string;
let servers: FeedServer[] = [];

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "anteros-runtime-"));
  servers = [];
});

afterEach(async () => {
  for (const server of servers) await server.close();
  await fs.rm(rootDir, { recursive: true, force: true });
});

async function startServer(routes: Map<string, Buffer | string>): Promise<FeedServer> {
  const server = await serveFeed(routes);
  servers.push(server);
  return server;
}

describe("插件运行环境", () => {
  it("整包安装：下载 → 校验 sha256 → 解包 → 原子落地", async () => {
    const files = [
      { path: "adapter/host.mjs", data: "export const version = '1.0.0';\n" },
      { path: "adapter/README.md", data: "# 运行环境 v1.0.0\n" },
    ];
    const archive = gzipSync(makeTar(files));
    const server = await startServer(
      new Map<string, Buffer | string>([
        ["/pkg-1.0.0.tar.gz", archive],
      ]),
    );
    const feed = {
      schema: 1,
      packages: {
        "channel.demo": {
          pluginId: "channel.demo",
          version: "1.0.0",
          archive: { url: `${server.baseUrl}/pkg-1.0.0.tar.gz`, sha256: sha256(archive), size: archive.length, format: "tar.gz" },
        },
      },
    };
    // 清单与包不同源：包在一个服务上，feed 在另一个服务上，证明地址是各自独立的
    const feedServer = await startServer(new Map<string, Buffer | string>([["/feed.json", JSON.stringify(feed)]]));
    const manager = new PluginRuntimeManager({ rootDir, log: silentLog, feedUrl: `${feedServer.baseUrl}/feed.json` });

    const status = await manager.install("channel.demo");
    expect(status.installed?.version).toBe("1.0.0");
    expect(status.installed?.mode).toBe("archive");
    expect(status.installed?.fileCount).toBe(2);
    expect(status.error).toBeNull();

    const onDisk = await fs.readFile(path.join(status.installed?.path ?? "", "adapter/host.mjs"), "utf8");
    expect(onDisk).toContain("1.0.0");
    await expect(fs.stat(path.join(status.installed?.path ?? "", "install.json"))).resolves.toBeTruthy();
  });

  it("增量升级：只下载 sha256 变了的文件，其余复用", async () => {
    // v1.0.0 整包
    const v1Files = [
      { path: "adapter/a.mjs", data: "a-1\n" },
      { path: "adapter/b.mjs", data: "b-1\n" },
      { path: "adapter/c.mjs", data: "c-1\n" },
    ];
    const v1Archive = gzipSync(makeTar(v1Files));
    const server = await startServer(new Map<string, Buffer | string>([["/v1.tar.gz", v1Archive]]));
    const feed1 = {
      schema: 1,
      packages: {
        "channel.demo": {
          version: "1.0.0",
          archive: { url: `${server.baseUrl}/v1.tar.gz`, sha256: sha256(v1Archive), size: v1Archive.length, format: "tar.gz" },
        },
      },
    };
    const feedServer = await startServer(new Map<string, Buffer | string>([["/feed.json", JSON.stringify(feed1)]]));
    const manager = new PluginRuntimeManager({ rootDir, log: silentLog, feedUrl: `${feedServer.baseUrl}/feed.json` });
    await manager.install("channel.demo");

    // v1.1.0：只有 b.mjs 变了
    const changed = Buffer.from("b-2\n", "utf8");
    const filesV2 = [
      { path: "adapter/a.mjs", data: "a-1\n" },
      { path: "adapter/b.mjs", data: "b-2\n" },
      { path: "adapter/c.mjs", data: "c-1\n" },
    ];
    const routes = new Map<string, Buffer | string>();
    for (const file of filesV2) {
      const bytes = Buffer.from(file.data, "utf8");
      routes.set(`/files/${sha256(bytes)}`, bytes);
    }
    const fileServer = await startServer(routes);
    const feed2 = {
      schema: 1,
      packages: {
        "channel.demo": {
          version: "1.1.0",
          files: filesV2.map((file) => {
            const bytes = Buffer.from(file.data, "utf8");
            return { path: file.path, sha256: sha256(bytes), size: bytes.length };
          }),
          filesBaseUrl: `${fileServer.baseUrl}/files`,
        },
      },
    };
    const feedServer2 = await startServer(new Map<string, Buffer | string>([["/feed.json", JSON.stringify(feed2)]]));
    manager.setFeedUrl(`${feedServer2.baseUrl}/feed.json`);

    const status = await manager.install("channel.demo");
    expect(status.installed?.version).toBe("1.1.0");
    expect(status.installed?.mode).toBe("delta");
    expect(status.updateAvailable).toBe(false);
    expect(await fs.readFile(path.join(status.installed?.path ?? "", "adapter/b.mjs"), "utf8")).toBe("b-2\n");
    // 只该请求 1 个文件（另外 2 个 sha 没变，必须复用）
    const downloaded = fileServer.hits.filter((hit) => hit.startsWith("/files/"));
    expect(downloaded.length).toBe(1);
    expect(changed.length).toBe(4);
  });

  it("校验不过就丢弃：sha256 对不上时旧版本保持原样", async () => {
    const good = gzipSync(makeTar([{ path: "adapter/a.mjs", data: "a-1\n" }]));
    const server = await startServer(new Map<string, Buffer | string>([["/good.tar.gz", good]]));
    const feedGood = {
      schema: 1,
      packages: {
        "channel.demo": {
          version: "1.0.0",
          archive: { url: `${server.baseUrl}/good.tar.gz`, sha256: sha256(good), size: good.length, format: "tar.gz" },
        },
      },
    };
    const feedServer = await startServer(new Map<string, Buffer | string>([["/feed.json", JSON.stringify(feedGood)]]));
    const manager = new PluginRuntimeManager({ rootDir, log: silentLog, feedUrl: `${feedServer.baseUrl}/feed.json` });
    await manager.install("channel.demo");

    // v2 的包被替换过（sha256 与清单不符）
    const tampered = gzipSync(makeTar([{ path: "adapter/a.mjs", data: "evil\n" }]));
    const badServer = await startServer(new Map<string, Buffer | string>([["/v2.tar.gz", tampered]]));
    const feedBad = {
      schema: 1,
      packages: {
        "channel.demo": {
          version: "2.0.0",
          archive: {
            url: `${badServer.baseUrl}/v2.tar.gz`,
            sha256: "0".repeat(64),
            size: tampered.length,
            format: "tar.gz",
          },
        },
      },
    };
    const badFeedServer = await startServer(new Map<string, Buffer | string>([["/feed.json", JSON.stringify(feedBad)]]));
    manager.setFeedUrl(`${badFeedServer.baseUrl}/feed.json`);

    await expect(manager.install("channel.demo")).rejects.toThrow(/校验失败/);
    const status = manager.status("channel.demo");
    expect(status.installed?.version).toBe("1.0.0");
    expect(status.error).toContain("校验失败");
    const stillThere = await fs.readFile(path.join(status.installed?.path ?? "", "adapter/a.mjs"), "utf8");
    expect(stillThere).toBe("a-1\n");
  });

  it("解包时拒绝越界路径（../ 与绝对路径）", () => {
    const tar = makeTar([{ path: "../evil.mjs", data: "x" }]);
    expect(() => untar(tar)).toThrow(/越界|绝对路径/);
  });

  it("更新源不支持 javascript: 之类的协议", () => {
    const manager = new PluginRuntimeManager({ rootDir, log: silentLog });
    expect(() => manager.setFeedUrl("javascript:alert(1)")).toThrow(/只支持/);
    expect(manager.getFeedUrl()).toContain("github.com");
  });

  it("卸载会删干净整个目录", async () => {
    const archive = gzipSync(makeTar([{ path: "adapter/a.mjs", data: "a\n" }]));
    const server = await startServer(new Map<string, Buffer | string>([["/pkg.tar.gz", archive]]));
    const feed = {
      schema: 1,
      packages: {
        "channel.demo": {
          version: "1.0.0",
          archive: { url: `${server.baseUrl}/pkg.tar.gz`, sha256: sha256(archive), size: archive.length, format: "tar.gz" },
        },
      },
    };
    const feedServer = await startServer(new Map<string, Buffer | string>([["/feed.json", JSON.stringify(feed)]]));
    const manager = new PluginRuntimeManager({ rootDir, log: silentLog, feedUrl: `${feedServer.baseUrl}/feed.json` });
    const installed = await manager.install("channel.demo");
    const dir = installed.installed?.path ?? "";
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
    const after = await manager.uninstall("channel.demo");
    expect(after.installed).toBeNull();
    await expect(fs.stat(dir)).rejects.toThrow();
  });
});
