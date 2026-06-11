'use client';

import { useEffect, useRef, useMemo } from 'react';
import hljs from 'highlight.js/lib/core';

// Register only the languages we need to keep the bundle small
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import shell from 'highlight.js/lib/languages/shell';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import xml from 'highlight.js/lib/languages/xml'; // also covers HTML
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import ini from 'highlight.js/lib/languages/ini'; // .ini, .toml, .env
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import java from 'highlight.js/lib/languages/java';
import swift from 'highlight.js/lib/languages/swift';
import cpp from 'highlight.js/lib/languages/cpp';
import c from 'highlight.js/lib/languages/c';
import graphql from 'highlight.js/lib/languages/graphql';
import makefile from 'highlight.js/lib/languages/makefile';
import plaintext from 'highlight.js/lib/languages/plaintext';

hljs.registerLanguage('python', python);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('php', php);
hljs.registerLanguage('java', java);
hljs.registerLanguage('swift', swift);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c', c);
hljs.registerLanguage('graphql', graphql);
hljs.registerLanguage('makefile', makefile);
hljs.registerLanguage('plaintext', plaintext);

// Map file extensions to highlight.js language identifiers
const EXT_TO_LANG: Record<string, string> = {
  py: 'python',
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  mdx: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  css: 'css',
  scss: 'scss',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  sql: 'sql',
  ini: 'ini',
  toml: 'ini',
  env: 'ini',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  java: 'java',
  kt: 'java', // close enough
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  graphql: 'graphql',
  prisma: 'graphql', // reasonable approximation
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  txt: 'plaintext',
  log: 'plaintext',
  lock: 'plaintext',
  gitignore: 'plaintext',
  gitattributes: 'plaintext',
  editorconfig: 'ini',
  dockerignore: 'plaintext',
};

function detectLanguage(filename: string): string {
  // Check exact filename first (Dockerfile, Makefile, etc.)
  const baseName = filename.split('/').pop() ?? filename;
  if (EXT_TO_LANG[baseName]) return EXT_TO_LANG[baseName];

  const parts = baseName.split('.');
  if (parts.length <= 1) return 'plaintext';
  const ext = parts[parts.length - 1].toLowerCase();
  return EXT_TO_LANG[ext] ?? 'plaintext';
}

interface SyntaxHighlighterProps {
  code: string;
  filename: string;
  className?: string;
}

export default function SyntaxHighlighter({ code, filename, className }: SyntaxHighlighterProps) {
  const codeRef = useRef<HTMLElement>(null);
  const language = useMemo(() => detectLanguage(filename), [filename]);

  const highlighted = useMemo(() => {
    try {
      const result = hljs.highlight(code, { language });
      return result.value;
    } catch {
      // Fallback: escape HTML and return as-is
      return code
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
  }, [code, language]);

  // Line numbers
  const lineCount = code.split('\n').length;
  const gutterWidth = String(lineCount).length;

  return (
    <div className={`syntax-hl-wrapper flex text-xs font-mono ${className ?? ''}`}>
      {/* Line number gutter */}
      <div
        className="select-none text-right pr-3 pt-4 pb-4 pl-3 text-slate-600 border-r border-slate-700/50 shrink-0 leading-[1.45]"
        aria-hidden="true"
        style={{ minWidth: `${gutterWidth + 2}ch` }}
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i + 1}>{i + 1}</div>
        ))}
      </div>
      {/* Code content */}
      <pre className="flex-1 overflow-x-auto p-4 m-0 leading-[1.45]">
        <code
          ref={codeRef}
          className={`hljs language-${language}`}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
}

export { detectLanguage };
