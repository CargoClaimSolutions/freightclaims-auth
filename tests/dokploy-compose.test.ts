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
    // chunked) would release the redirect row early, so each directive appears once, at server level.
    expect(loginBufferingDirectives(productLoginProxy)).toEqual(serverLoginBufferingDirectives);
    expect(productLoginProxy).toContain("https://github.com/zitadel/zitadel/issues/12745");
    expect(productLoginProxy).toContain("https://github.com/vercel/next.js/issues/81377");
    expect(productLoginProxy).not.toMatch(/proxy_buffering\s+off|X-Accel-Buffering/i);
  });

  it("finds a buffering override wherever it sits on a line", () => {
    for (const [anchor, override] of [
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
});

const serverLoginBufferingDirectives = [
  "server: proxy_buffering on",
  "server: proxy_buffer_size 64k",
  "server: proxy_buffers 8 64k",
  "server: proxy_busy_buffers_size 128k",
  "server: proxy_http_version 1.0",
];

function loginBufferingDirectives(config: string): string[] {
  return parseNginxStatements(config)
    .filter(({ name }) =>
      [
        "proxy_buffering",
        "proxy_buffer_size",
        "proxy_buffers",
        "proxy_busy_buffers_size",
        "proxy_http_version",
      ].includes(name),
    )
    .map(({ name, args, blocks }) => `${blocks.join(" > ")}: ${[name, ...args].join(" ")}`);
}

// Reads statements the way nginx does: `#` starts a comment at the start of a word, a quote at the
// start of a word runs to the matching quote, and `;`, `{` and `}` end a statement wherever they
// sit on a line (except `${...}` inside a word). `blocks` lists the enclosing blocks, outermost first.
function parseNginxStatements(
  config: string,
): { name: string; args: string[]; blocks: string[] }[] {
  const statements: { name: string; args: string[]; blocks: string[] }[] = [];
  const blocks: string[] = [];
  let words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  let variableBrace = false;
  const endWord = () => {
    if (word !== undefined) words.push(word);
    word = undefined;
    variableBrace = false;
  };
  const endStatement = () => {
    endWord();
    const [name, ...args] = words;
    if (name === undefined) throw new Error("nginx config has an empty statement");
    statements.push({ name, args, blocks: [...blocks] });
    words = [];
    return [name, ...args].join(" ");
  };
  for (let i = 0; i < config.length; i++) {
    const ch = config[i] as string;
    if (ch === "\\") {
      word = `${word ?? ""}${ch}${config[++i] ?? ""}`;
    } else if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
        endWord();
      } else {
        word += ch;
      }
    } else if (word === undefined && (ch === '"' || ch === "'")) {
      quote = ch;
      word = "";
    } else if (word === undefined && ch === "#") {
      while (i + 1 < config.length && config[i + 1] !== "\n") i++;
    } else if (ch === "{" && word?.endsWith("$")) {
      word += ch;
      variableBrace = true;
    } else if (ch === "}" && variableBrace) {
      word += ch;
      variableBrace = false;
    } else if (ch === ";") {
      endStatement();
    } else if (ch === "{") {
      blocks.push(endStatement());
    } else if (ch === "}") {
      endWord();
      if (words.length > 0 || blocks.pop() === undefined) {
        throw new Error("nginx config has an unexpected }");
      }
    } else if (/\s/.test(ch)) {
      endWord();
    } else {
      word = `${word ?? ""}${ch}`;
    }
  }
  endWord();
  if (quote !== undefined || words.length > 0 || blocks.length > 0) {
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
