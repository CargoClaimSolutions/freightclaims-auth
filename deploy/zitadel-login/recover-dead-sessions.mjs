// Login V2 remembers each signed-in account in its `sessions` cookie together with a session token.
// ZITADEL replaces that token whenever the session is checked again, for example when Continue is
// pressed a second time while the browser is already leaving for the application. If the browser
// never receives the replacement, the remembered token stops working, and Login V2 v4.16.2 then
// blocks every later sign-in for that account:
//   - the password page crashes ("An error occurred in the Server Components render"), because
//     loadMostRecentSession treats only a missing session, not a refused token
//     (PermissionDenied, QUERY-dsfr3), as "no session";
//   - choosing the account in the account list does nothing, because continueWithSession hands
//     the refused token to ZITADEL (COMMAND-sGr42) and the error is not shown.
// This script patches the compiled server code so a refused token counts as no session: the
// password page renders, choosing the account leads to the password step, and the next password
// check replaces the dead entry. Upstream main is unchanged as of 2026-10-27 (the open discussion is
// https://github.com/zitadel/zitadel/issues/12209). The build fails when a pattern no longer
// matches every site, so a Login V2 upgrade must re-check this patch or delete it.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const serverDirectory = process.argv[2];
if (!serverDirectory) throw new Error("Usage: node recover-dead-sessions.mjs <.next/server>");

const patches = [
  {
    name: "loadMostRecentSession treats a refused token as no session",
    anchor: '"[Session] Could not load most recent session"',
    pattern:
      /(\w+)\.code===(\w+)\.NotFound\)(return void console\.warn\("\[Session\] Could not load most recent session")/g,
    replacement: "($1.code===$2.NotFound||$1.code===$2.PermissionDenied))$3",
  },
  {
    name: "continueWithSession sends an account whose token is refused to the password step",
    anchor: '"continueWithSession: session is not valid',
    pattern:
      /if\(!await \(0,(\w+)\.isSessionValid\)\(\{serviceConfig:(\w+),session:(\w+)\}\)\)(\{\w+\.warn\("continueWithSession: session is not valid)/g,
    replacement:
      "if(!await (0,$1.isSessionValid)({serviceConfig:$2,session:$3})||!await (0,$1.loadMostRecentSession)({serviceConfig:$2,sessionParams:{loginName:$3.factors.user.loginName,organization:$3.factors.user.organizationId}}))$4",
  },
];

function* javascriptFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* javascriptFiles(path);
    else if (entry.name.endsWith(".js")) yield path;
  }
}

// The second patch calls loadMostRecentSession through the module continueWithSession imports
// isSessionValid from (`n=a.i(85397)`), so that module's export list (`a.s([...],85397)`) must
// still name it, or every account click would throw.
const sessionModuleIds = new Set();
const exportLists = new Map();
const counts = patches.map(() => ({ anchors: 0, replaced: 0 }));
for (const file of javascriptFiles(serverDirectory)) {
  const original = readFileSync(file, "utf8");
  for (const [, names, id] of original.matchAll(/\w+\.s\(\[([^\]]*)\],(\d+)\)/g)) {
    exportLists.set(id, `${exportLists.get(id) ?? ""}${names},`);
  }
  for (const site of original.matchAll(patches[1].pattern)) {
    const imports = original
      .slice(0, site.index)
      .matchAll(new RegExp(`\\b${site[1]}=\\w+\\.i\\((\\d+)\\)`, "g"));
    sessionModuleIds.add([...imports].at(-1)?.[1]);
  }
  let source = original;
  patches.forEach((patch, index) => {
    counts[index].anchors += source.split(patch.anchor).length - 1;
    counts[index].replaced += source.match(patch.pattern)?.length ?? 0;
    source = source.replace(patch.pattern, patch.replacement);
  });
  if (source !== original) writeFileSync(file, source);
}

patches.forEach((patch, index) => {
  const { anchors, replaced } = counts[index];
  if (anchors === 0 || replaced !== anchors) {
    throw new Error(`${patch.name}: patched ${replaced} of ${anchors} sites`);
  }
  console.log(`${patch.name}: patched ${replaced} of ${anchors} sites`);
});
for (const id of sessionModuleIds) {
  if (!exportLists.get(id)?.includes('"loadMostRecentSession",')) {
    throw new Error(
      `continueWithSession's session module ${id} does not export loadMostRecentSession`,
    );
  }
}
console.log(
  `loadMostRecentSession is exported by session module ${[...sessionModuleIds].join(", ")}`,
);
