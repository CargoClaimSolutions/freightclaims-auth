import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const hostedCompose = readFileSync(
  new URL("../deploy/dokploy/compose.yml", import.meta.url),
  "utf8",
);
const productLoginProxy = readFileSync(
  new URL("../deploy/dokploy/product-login-root.nginx.conf", import.meta.url),
  "utf8",
);

describe("Dokploy Compose ownership", () => {
  it("leaves public domains and Traefik networking to Dokploy", () => {
    expect(hostedCompose).not.toContain("traefik.");
    expect(hostedCompose).not.toContain("dokploy-network");
    expect(hostedCompose).toContain("product-login-root:");
  });

  it("serves product branding assets from the canonical ZITADEL instance", () => {
    expect(productLoginProxy).toContain("location /assets/");
    expect(productLoginProxy).toContain("proxy_set_header Host auth.freightclaims.com;");
    expect(productLoginProxy).toContain("proxy_pass http://$zitadel_api_upstream;");
  });

  it("bounds setup-email triggers while proxying Login V2", () => {
    expect(productLoginProxy).toContain(
      "limit_req_zone $login_name_limit_key zone=login_name_actions:10m rate=10r/m;",
    );
    expect(productLoginProxy).toContain(
      '"~^(?<ipv6_prefix>[\\s\\S]{8})[\\s\\S]{8}$" $ipv6_prefix;',
    );
    expect(productLoginProxy).toContain("POST $login_name_client_key;");
    expect(productLoginProxy).not.toContain("$http_cf_connecting_ip");
    expect(productLoginProxy).toContain("set_real_ip_from 173.245.48.0/20;");
    expect(productLoginProxy).toContain("location ~ ^/ui/v2/login/loginname/?$");
    expect(productLoginProxy).toContain("limit_req zone=login_name_actions burst=5 nodelay;");
    expect(productLoginProxy).toContain("resolver 127.0.0.11 valid=10s ipv6=off;");
    expect(productLoginProxy).toContain("proxy_pass http://$zitadel_login_upstream;");
    expect(productLoginProxy).toContain("location /ui/v2/login {");
    expect(productLoginProxy).not.toContain("return 308 /ui/v2/login/;");
  });

  it("delivers each Login V2 response in one piece for every location", () => {
    // A location-level override (smaller buffers, or HTTP/1.1, which makes the upstream answer
    // chunked) would release the redirect row early, and so would a second server block, which runs
    // on nginx's defaults for its hosts. So the file has one server block and each directive appears
    // once, at its top level. An included file could do either out of this test's sight, so the
    // file includes nothing, and Compose gives nginx no other config file.
    expect(loginBufferingDirectives(productLoginProxy)).toEqual(serverLoginBufferingDirectives);
    expect(productLoginProxy).toContain("https://github.com/zitadel/zitadel/issues/12745");
    expect(productLoginProxy).toContain("https://github.com/vercel/next.js/issues/81377");
    expect(productLoginProxy).not.toMatch(/proxy_buffering\s+off|X-Accel-Buffering/i);
  });

  it("finds a buffering override, a second server block or an include wherever it sits on a line", () => {
    for (const [anchor, override] of [
      [
        "server {\n",
        "server { listen 8080; server_name auth.freightclaims.com; location /ui/v2/login { proxy_pass http://$zitadel_login_upstream; } }\n",
      ],
      [
        "  location / {\n",
        "  location /ui/v2/login/otp { proxy_http_version 1.1; proxy_pass http://$zitadel_login_upstream; }\n",
      ],
      [
        "    proxy_set_header Host $host;\n",
        "    proxy_set_header Host $host; proxy_buffer_size 4k;\n",
      ],
      ["  location / {\n", "  location /ui/v2/login/otp {proxy_buffers 8 4k;}\n"],
      ["  location / {\n", '  location /ui/v2/login/otp { "proxy_buffering" off; }\n'],
      ["  location / {\n", `  location /ui/v2/login/x\\\${ proxy_buffer_size 4k; }\n`],
      ["  location / {\n", "  location /ui/v2/login/a}b { proxy_buffer_size 4k; }\n"],
      ["server {\n", "include /etc/nginx/snippets/*.conf;\n"],
      [
        "    proxy_set_header Host $host;\n",
        "    proxy_set_header Host $host; include /etc/nginx/snippets/proxy.conf;\n",
      ],
    ] as const) {
      expect(productLoginProxy).toContain(anchor);
      const overridden = productLoginProxy.replace(anchor, `${override}${anchor}`);
      expect(loginBufferingDirectives(overridden)).not.toEqual(serverLoginBufferingDirectives);
    }
    expect(
      loginBufferingDirectives(
        productLoginProxy.replace(
          "    proxy_set_header Host $host;\n",
          "    # proxy_buffer_size 4k;\n",
        ),
      ),
    ).toEqual(serverLoginBufferingDirectives);
  });

  it("gives nginx no config file but product-login-root.nginx.conf", () => {
    // nginx.conf in the image includes /etc/nginx/conf.d/*.conf, and the image's only file there is
    // the default.conf that this mount replaces.
    const loginRootService = hostedCompose
      .split("\n  product-login-root:\n")[1]
      ?.split(/\n {2}\S/)[0];
    expect(loginRootService).toContain(
      "    volumes:\n      - ./product-login-root.nginx.conf:/etc/nginx/conf.d/default.conf:ro\n    networks:",
    );
    expect(loginRootService?.match(/\/etc\/nginx|configs:|command:|entrypoint:/g)).toEqual([
      "/etc/nginx",
    ]);
  });

  it("reads the config the way nginx does", () => {
    // Inside a server block, nginx 1.29.5 answers ?c=d with "a}b|<host>}|f#g|"}|o\ff" from the `if`.
    expect(
      parseNginxStatements(
        `set $a a}b; set $b \${host}}; location /x\\\${ "proxy_buffering" off; } ` +
          'if ($arg_c = "d") { set $e f#g; return 200 "$a|$b|$e|\\"}|o\\ff"; }',
      ),
    ).toEqual([
      { name: "set", args: ["$a", "a}b"], blocks: [] },
      { name: "set", args: ["$b", `\${host}}`], blocks: [] },
      { name: "location", args: ["/x\\$"], blocks: [] },
      { name: "proxy_buffering", args: ["off"], blocks: ["location /x\\$"] },
      { name: "if", args: ["($arg_c", "=", "d", ")"], blocks: [] },
      { name: "set", args: ["$e", "f#g"], blocks: ["if ($arg_c = d )"] },
      { name: "return", args: ["200", '$a|$b|$e|"}|o\\ff'], blocks: ["if ($arg_c = d )"] },
    ]);
    // nginx -t -c rejects each of these as a whole file.
    for (const rejected of [
      '"worker_processes"1;',
      'events { worker_connections "8"}',
      "worker_processes 1}",
      "worker_processes 1;}",
      ";",
      "events {",
      'events { } "',
    ]) {
      expect(() => parseNginxStatements(rejected)).toThrow();
    }
  });
});

const serverLoginBufferingDirectives = [
  "http: server",
  "server: proxy_buffering on",
  "server: proxy_buffer_size 64k",
  "server: proxy_buffers 8 64k",
  "server: proxy_busy_buffers_size 128k",
  "server: proxy_http_version 1.0",
];

// Lists each top-level server block, each include and each buffering directive with its enclosing
// blocks. nginx includes conf.d files inside its http block.
function loginBufferingDirectives(config: string): string[] {
  return parseNginxStatements(config)
    .filter(
      ({ name, blocks }) =>
        (name === "server" && blocks.length === 0) ||
        [
          "include",
          "proxy_buffering",
          "proxy_buffer_size",
          "proxy_buffers",
          "proxy_busy_buffers_size",
          "proxy_http_version",
        ].includes(name),
    )
    .map(
      ({ name, args, blocks }) => `${blocks.join(" > ") || "http"}: ${[name, ...args].join(" ")}`,
    );
}

// Reads statements the way nginx's ngx_conf_read_token does, and throws where it would. Space, tab,
// CR and LF separate words. At the start of a word, `#` starts a comment, a quote runs to the
// matching quote (which must be followed by a separator, `;`, `{` or `)`), and `;`, `{` and `}` end
// a statement or block. Inside a word, `;` and `{` end the statement but `}` is literal, and so is a
// `{` straight after an unescaped `$`. A backslash escapes the next character; only `\"`, `\'`,
// `\\`, `\t`, `\r` and `\n` are unescaped. `blocks` lists the enclosing blocks, outermost first.
function parseNginxStatements(
  config: string,
): { name: string; args: string[]; blocks: string[] }[] {
  const statements: { name: string; args: string[]; blocks: string[] }[] = [];
  const blocks: string[] = [];
  let words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  let comment = false;
  let escaped = false;
  let variable = false;
  let needSpace = false;
  const unescaped: Record<string, string> = { t: "\t", r: "\r", n: "\n" };
  const isSpace = (ch: string) => ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
  const endWord = () => {
    if (word !== undefined) {
      words.push(word.replace(/\\(["'\\tnr])/g, (_, ch: string) => unescaped[ch] ?? ch));
    }
    word = undefined;
  };
  const endStatement = (end: string) => {
    endWord();
    const [name, ...args] = words;
    if (name === undefined) throw new Error(`nginx config has an unexpected ${end}`);
    statements.push({ name, args, blocks: [...blocks] });
    if (end === "{") blocks.push([name, ...args].join(" "));
    words = [];
  };
  for (const ch of config) {
    if (comment) {
      comment = ch !== "\n";
      continue;
    }
    if (escaped) {
      word += ch;
      escaped = false;
      continue;
    }
    if (needSpace) {
      needSpace = false;
      if (isSpace(ch)) continue;
      if (ch === ";" || ch === "{") {
        endStatement(ch);
        continue;
      }
      if (ch !== ")") throw new Error(`nginx config has an unexpected ${ch} after a quoted string`);
    }
    if (word === undefined) {
      if (isSpace(ch)) continue;
      if (ch === ";" || ch === "{") {
        endStatement(ch);
        continue;
      }
      if (ch === "}") {
        if (words.length > 0 || blocks.pop() === undefined) {
          throw new Error("nginx config has an unexpected }");
        }
        continue;
      }
      if (ch === "#") {
        comment = true;
        continue;
      }
      word = "";
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
    }
    if (ch === "{" && variable) {
      word += ch;
      continue;
    }
    variable = ch === "$";
    escaped = ch === "\\";
    if (ch === quote) {
      quote = undefined;
      endWord();
      needSpace = true;
    } else if (quote === undefined && isSpace(ch)) {
      endWord();
    } else if (quote === undefined && (ch === ";" || ch === "{")) {
      endStatement(ch);
    } else {
      word += ch;
    }
  }
  if (
    escaped ||
    quote !== undefined ||
    word !== undefined ||
    words.length > 0 ||
    blocks.length > 0
  ) {
    throw new Error("nginx config ends inside a statement, block or quoted string");
  }
  return statements;
}

it("requires native email verification for initialized invite recipients", () => {
  const loginService = hostedCompose
    .split("\n  zitadel-login:\n")[1]
    ?.split("  product-login-root:")[0];
  expect(loginService).toContain('EMAIL_VERIFICATION: "true"');
});
