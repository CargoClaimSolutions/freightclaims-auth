import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";

// Runs deploy/dokploy/product-login-root.nginx.conf in the hosted nginx image in front of a fake
// Login V2 that streams a server-action response the way Next.js does: the redirect row first, then
// the re-rendered page. The hosted config must hold the response until it is complete. The same
// config without its proxy_buffer* directives runs on nginx's default buffers (buffering on, 4k
// pages), as the hosted config did before this fix. That baseline must release the redirect row
// early, which shows the check would catch a regression.

const burstDelayMilliseconds = 500;
const lastBurstMilliseconds = 2 * burstDelayMilliseconds;
const bursts = [
  `0:{"a":"$@1"}\n1:{"redirect":"https://app.example/auth/callback?code=c&state=s"}\n${"a".repeat(3_000)}\n`,
  `5:${"b".repeat(10_000)}\n`,
  `6:${"c".repeat(18_000)}\n`,
];

const fakeLoginV2 = `
const http = require("node:http");
const bursts = ${JSON.stringify(bursts)};
http.createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    if (request.method !== "POST") return response.end("ok");
    response.writeHead(200, { "content-type": "text/x-component" });
    response.write(bursts[0]);
    setTimeout(() => response.write(bursts[1]), ${burstDelayMilliseconds});
    setTimeout(() => response.end(bursts[2]), ${lastBurstMilliseconds});
  });
}).listen(3000);
`;

const hostedConfig = readFileSync(
  new URL("../deploy/dokploy/product-login-root.nginx.conf", import.meta.url),
  "utf8",
);
const defaultBuffersConfig = hostedConfig.replace(
  /^\s*proxy_(?:buffering|buffer_size|buffers|busy_buffers_size)\s[^;]*;\n/gm,
  "",
);
const hostedCompose = readFileSync(
  new URL("../deploy/dokploy/compose.yml", import.meta.url),
  "utf8",
);
const nginxImage = /\n {2}product-login-root:\n {4}image: (\S+)\n/.exec(hostedCompose)?.[1];
const nodeImage = "node:24-alpine";

interface Delivery {
  readonly redirectMilliseconds: number;
  readonly completeMilliseconds: number;
  readonly bodyBytes: number;
}

function docker(...arguments_: string[]): string {
  return execFileSync("docker", arguments_, { encoding: "utf8" }).trim();
}

function send(port: number, method: string, path: string): Promise<Delivery> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const body = "[]";
    const outgoing = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { "content-type": "text/plain;charset=UTF-8", "content-length": body.length },
      },
      (response) => {
        let received = "";
        let redirectMilliseconds = Number.NaN;
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          received += chunk;
          if (Number.isNaN(redirectMilliseconds) && received.includes('"redirect"')) {
            redirectMilliseconds = performance.now() - started;
          }
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`${method} ${path} answered ${String(response.statusCode)}`));
            return;
          }
          resolve({
            redirectMilliseconds,
            completeMilliseconds: performance.now() - started,
            bodyBytes: Buffer.byteLength(received),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

async function waitUntilReady(port: number, container: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        request({ host: "127.0.0.1", port, path: "/ui/v2/login/healthy" }, (response) => {
          response.resume();
          resolve(response.statusCode);
        })
          .on("error", reject)
          .end();
      });
      if (status === 200) return;
    } catch {
      // nginx is still starting.
    }
    if (Date.now() > deadline) {
      throw new Error(`nginx did not become ready:\n${docker("logs", container)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function measure(
  network: string,
  name: string,
  config: string,
): Promise<Map<string, Delivery>> {
  if (!nginxImage) throw new Error("compose.yml does not pin the product-login-root image");
  docker(
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    network,
    "--publish",
    "127.0.0.1::8080",
    "--env",
    `NGINX_CONF=${config}`,
    nginxImage,
    "sh",
    "-c",
    'printf "%s" "$NGINX_CONF" > /etc/nginx/conf.d/default.conf && exec nginx -g "daemon off;"',
  );
  const port = Number(docker("port", name, "8080/tcp").split("\n")[0]?.split(":").at(-1));
  await waitUntilReady(port, name);
  const deliveries = new Map<string, Delivery>();
  for (const path of ["/ui/v2/login/password", "/ui/v2/login/loginname"]) {
    deliveries.set(path, await send(port, "POST", path));
  }
  return deliveries;
}

function report(label: string, deliveries: Map<string, Delivery>): void {
  for (const [path, delivery] of deliveries) {
    console.log(
      `${label.padEnd(10)} POST ${path.padEnd(24)} redirect row at ${delivery.redirectMilliseconds.toFixed(0).padStart(5)} ms, complete at ${delivery.completeMilliseconds.toFixed(0).padStart(5)} ms, ${String(delivery.bodyBytes)} B`,
    );
  }
}

async function main(): Promise<void> {
  if (defaultBuffersConfig === hostedConfig) {
    throw new Error("product-login-root.nginx.conf sets no proxy_buffer* directives");
  }
  // On a user-defined network Docker's resolver at 127.0.0.11 answers for the aliases, as it does
  // in the hosted Compose project.
  const suffix = randomBytes(4).toString("hex");
  const network = `login-buffering-check-${suffix}`;
  const containers = [`${network}-login`, `${network}-hosted`, `${network}-default-4k`];
  docker("network", "create", network);
  try {
    docker(
      "run",
      "--detach",
      "--name",
      `${network}-login`,
      "--network",
      network,
      "--network-alias",
      "zitadel-login",
      nodeImage,
      "node",
      "-e",
      fakeLoginV2,
    );
    const failures: string[] = [];
    const hosted = await measure(network, `${network}-hosted`, hostedConfig);
    const defaultBuffers = await measure(network, `${network}-default-4k`, defaultBuffersConfig);
    report("hosted", hosted);
    report("default-4k", defaultBuffers);
    for (const [path, delivery] of hosted) {
      if (!(delivery.redirectMilliseconds >= lastBurstMilliseconds - 100)) {
        failures.push(
          `hosted config released the redirect row of ${path} before the response ended`,
        );
      }
      if (delivery.completeMilliseconds - delivery.redirectMilliseconds > 100) {
        failures.push(`hosted config delivered ${path} in more than one piece`);
      }
    }
    for (const [path, delivery] of defaultBuffers) {
      if (!(delivery.redirectMilliseconds < lastBurstMilliseconds - 100)) {
        failures.push(`the check cannot tell: default 4k buffers also held ${path} until it ended`);
      }
    }
    if (failures.length > 0) throw new Error(failures.join("\n"));
    console.log("Login V2 action responses reach the client in one piece.");
  } finally {
    spawnSync("docker", ["rm", "--force", ...containers], { stdio: "ignore" });
    spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
  }
}

await main();
