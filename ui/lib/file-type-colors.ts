/**
 * VS Code-style file-type color mapping for workspace file explorer.
 * Maps file extensions to display colors (Tailwind classes) and optional label text.
 * Designed for dark theme readability.
 */

export interface FileTypeStyle {
  /** Tailwind text color class for the icon */
  iconColor: string;
  /** Tailwind text color class for the file name label */
  nameColor: string;
  /** Short language/type label (optional, for badges) */
  label?: string;
}

// ─── Extension → Style Map ────────────────────────────────────────────────────
// Colors chosen to match VS Code / familiar editor conventions on dark backgrounds.

const EXT_STYLE_MAP: Record<string, FileTypeStyle> = {
  // TypeScript — blue (VS Code convention)
  ts:   { iconColor: 'text-blue-400',    nameColor: 'text-blue-300',    label: 'TS' },
  tsx:  { iconColor: 'text-blue-400',    nameColor: 'text-blue-300',    label: 'TSX' },
  'd.ts': { iconColor: 'text-blue-400',  nameColor: 'text-blue-300',    label: 'DTS' },

  // JavaScript — yellow (VS Code convention)
  js:   { iconColor: 'text-yellow-400',  nameColor: 'text-yellow-300',  label: 'JS' },
  jsx:  { iconColor: 'text-yellow-400',  nameColor: 'text-yellow-300',  label: 'JSX' },
  mjs:  { iconColor: 'text-yellow-400',  nameColor: 'text-yellow-300',  label: 'MJS' },
  cjs:  { iconColor: 'text-yellow-400',  nameColor: 'text-yellow-300',  label: 'CJS' },

  // Python — green/teal (VS Code convention)
  py:   { iconColor: 'text-emerald-400', nameColor: 'text-emerald-300', label: 'PY' },
  pyi:  { iconColor: 'text-emerald-400', nameColor: 'text-emerald-300', label: 'PYI' },
  pyx:  { iconColor: 'text-emerald-400', nameColor: 'text-emerald-300', label: 'PYX' },

  // JSON — amber/orange
  json: { iconColor: 'text-amber-400',   nameColor: 'text-amber-300',   label: 'JSON' },

  // Markdown — sky blue
  md:   { iconColor: 'text-sky-400',     nameColor: 'text-sky-300',     label: 'MD' },
  mdx:  { iconColor: 'text-sky-400',     nameColor: 'text-sky-300',     label: 'MDX' },

  // Shell — green
  sh:   { iconColor: 'text-green-400',   nameColor: 'text-green-300',   label: 'SH' },
  bash: { iconColor: 'text-green-400',   nameColor: 'text-green-300',   label: 'BASH' },
  zsh:  { iconColor: 'text-green-400',   nameColor: 'text-green-300',   label: 'ZSH' },
  fish: { iconColor: 'text-green-400',   nameColor: 'text-green-300',   label: 'FISH' },

  // CSS / SCSS — purple/violet (VS Code convention)
  css:  { iconColor: 'text-violet-400',  nameColor: 'text-violet-300',  label: 'CSS' },
  scss: { iconColor: 'text-pink-400',    nameColor: 'text-pink-300',    label: 'SCSS' },
  less: { iconColor: 'text-violet-400',  nameColor: 'text-violet-300',  label: 'LESS' },

  // HTML — orange/red (VS Code convention)
  html: { iconColor: 'text-orange-400',  nameColor: 'text-orange-300',  label: 'HTML' },
  htm:  { iconColor: 'text-orange-400',  nameColor: 'text-orange-300',  label: 'HTM' },

  // YAML / TOML / Config — rose/pink
  yaml: { iconColor: 'text-rose-400',    nameColor: 'text-rose-300',    label: 'YAML' },
  yml:  { iconColor: 'text-rose-400',    nameColor: 'text-rose-300',    label: 'YML' },
  toml: { iconColor: 'text-rose-400',    nameColor: 'text-rose-300',    label: 'TOML' },
  ini:  { iconColor: 'text-rose-300',    nameColor: 'text-rose-200',    label: 'INI' },

  // XML / SVG
  xml:  { iconColor: 'text-orange-300',  nameColor: 'text-orange-200',  label: 'XML' },
  svg:  { iconColor: 'text-amber-300',   nameColor: 'text-amber-200',   label: 'SVG' },

  // SQL
  sql:  { iconColor: 'text-cyan-400',    nameColor: 'text-cyan-300',    label: 'SQL' },

  // GraphQL / Prisma
  graphql: { iconColor: 'text-pink-400', nameColor: 'text-pink-300',    label: 'GQL' },
  prisma:  { iconColor: 'text-indigo-400', nameColor: 'text-indigo-300', label: 'PRISMA' },

  // Rust — orange
  rs:   { iconColor: 'text-orange-400',  nameColor: 'text-orange-300',  label: 'RS' },

  // Go — cyan
  go:   { iconColor: 'text-cyan-400',    nameColor: 'text-cyan-300',    label: 'GO' },

  // Ruby — red
  rb:   { iconColor: 'text-red-400',     nameColor: 'text-red-300',     label: 'RB' },

  // PHP — indigo
  php:  { iconColor: 'text-indigo-400',  nameColor: 'text-indigo-300',  label: 'PHP' },

  // Java / Kotlin — orange/purple
  java: { iconColor: 'text-orange-400',  nameColor: 'text-orange-300',  label: 'JAVA' },
  kt:   { iconColor: 'text-purple-400',  nameColor: 'text-purple-300',  label: 'KT' },

  // Swift — orange
  swift:{ iconColor: 'text-orange-400',  nameColor: 'text-orange-300',  label: 'SWIFT' },

  // C / C++
  c:    { iconColor: 'text-blue-300',    nameColor: 'text-blue-200',    label: 'C' },
  cpp:  { iconColor: 'text-blue-400',    nameColor: 'text-blue-300',    label: 'C++' },
  h:    { iconColor: 'text-blue-300',    nameColor: 'text-blue-200',    label: 'H' },

  // Plain text
  txt:  { iconColor: 'text-slate-400',   nameColor: 'text-slate-300',   label: 'TXT' },
  log:  { iconColor: 'text-slate-500',   nameColor: 'text-slate-400',   label: 'LOG' },

  // Env / config dotfiles
  env:  { iconColor: 'text-yellow-300',  nameColor: 'text-yellow-200',  label: 'ENV' },

  // Lock files
  lock: { iconColor: 'text-slate-500',   nameColor: 'text-slate-400',   label: 'LOCK' },

  // Images
  png:  { iconColor: 'text-purple-400',  nameColor: 'text-purple-300',  label: 'IMG' },
  jpg:  { iconColor: 'text-purple-400',  nameColor: 'text-purple-300',  label: 'IMG' },
  jpeg: { iconColor: 'text-purple-400',  nameColor: 'text-purple-300',  label: 'IMG' },
  gif:  { iconColor: 'text-purple-400',  nameColor: 'text-purple-300',  label: 'IMG' },
  webp: { iconColor: 'text-purple-400',  nameColor: 'text-purple-300',  label: 'IMG' },
  ico:  { iconColor: 'text-purple-400',  nameColor: 'text-purple-300',  label: 'ICO' },
  bmp:  { iconColor: 'text-purple-400',  nameColor: 'text-purple-300',  label: 'IMG' },
  tiff: { iconColor: 'text-purple-400',  nameColor: 'text-purple-300',  label: 'IMG' },
  tif:  { iconColor: 'text-purple-400',  nameColor: 'text-purple-300',  label: 'IMG' },

  // Docker
  dockerfile: { iconColor: 'text-cyan-400', nameColor: 'text-cyan-300', label: 'DOCKER' },
};

// ─── Special filename matches (no extension) ─────────────────────────────────
const FILENAME_STYLE_MAP: Record<string, FileTypeStyle> = {
  'Dockerfile':     EXT_STYLE_MAP.dockerfile,
  'Makefile':       { iconColor: 'text-orange-300', nameColor: 'text-orange-200', label: 'MAKE' },
  '.gitignore':     { iconColor: 'text-slate-400',  nameColor: 'text-slate-300',  label: 'GIT' },
  '.gitattributes': { iconColor: 'text-slate-400',  nameColor: 'text-slate-300',  label: 'GIT' },
  '.editorconfig':  { iconColor: 'text-slate-400',  nameColor: 'text-slate-300',  label: 'CFG' },
  '.dockerignore':  { iconColor: 'text-cyan-400',   nameColor: 'text-cyan-300',   label: 'DOCKER' },
  '.env':           EXT_STYLE_MAP.env,
  '.env.local':     EXT_STYLE_MAP.env,
  '.env.production': EXT_STYLE_MAP.env,
};

// ─── Fallback ─────────────────────────────────────────────────────────────────
const DEFAULT_STYLE: FileTypeStyle = {
  iconColor: 'text-slate-400',
  nameColor: 'text-slate-300',
};

const FOLDER_STYLE: FileTypeStyle = {
  iconColor: 'text-amber-400',
  nameColor: 'text-amber-200/90',
  label: 'DIR',
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the display style for a file based on its name.
 * Returns icon color, name color, and optional type label.
 */
export function getFileTypeStyle(fileName: string, isDir = false): FileTypeStyle {
  if (isDir) return FOLDER_STYLE;

  // Check exact filename first (for dotfiles and special names)
  if (FILENAME_STYLE_MAP[fileName]) return FILENAME_STYLE_MAP[fileName];

  // Check extension
  const ext = getExt(fileName);
  if (ext && EXT_STYLE_MAP[ext]) return EXT_STYLE_MAP[ext];

  return DEFAULT_STYLE;
}

function getExt(name: string): string {
  const parts = name.split('.');
  if (parts.length <= 1) return '';
  return parts[parts.length - 1].toLowerCase();
}
