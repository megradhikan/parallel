import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// Self-hosted workers, bundled by Vite. The default monaco-editor setup pulls
// its workers from a CDN via AMD loader, which breaks under a static host with
// a strict CSP (and on Vercel preview URLs) — bundling them avoids that
// entirely (PRD section 4, editor row).
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

// No language server, no linting: the file is a scratch buffer shared over the
// network, so TypeScript's own diagnostics would flag half-typed code from
// other people as errors (PRD 3.3).
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true,
});

export { monaco };
