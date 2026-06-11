'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, SkillDetail } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, FileText, FolderOpen, File } from 'lucide-react';
import SkillEditor from '@/components/SkillEditor';

interface SkillFiles {
  name: string;
  source: string;
  files: string[];
}

function buildFileTree(files: string[]): Record<string, string[] | null> {
  const tree: Record<string, string[] | null> = {};
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length === 1) {
      // Root file
      if (!tree['']) tree[''] = [];
      tree['']!.push(f);
    } else {
      const dir = parts[0];
      if (!tree[dir]) tree[dir] = [];
      tree[dir]!.push(f);
    }
  }
  return tree;
}

function getFileIcon(filename: string) {
  if (filename.endsWith('.py')) return '🐍';
  if (filename.endsWith('.md')) return '📄';
  if (filename.endsWith('.sh')) return '⚡';
  if (filename.endsWith('.ts') || filename.endsWith('.js')) return '📜';
  if (filename.endsWith('.json') || filename.endsWith('.yaml') || filename.endsWith('.yml')) return '⚙️';
  return '📎';
}

export default function SkillDetailPage() {
  const params = useParams();
  const router = useRouter();
  const name = decodeURIComponent(params.name as string);

  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [skillFiles, setSkillFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string>('SKILL.md');
  const [fileContent, setFileContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.getSkill(name),
      api.getSkills(),
    ])
      .then(([skillData, allSkills]) => {
        setSkill(skillData);
        setFileContent(skillData.content);
        const match = allSkills.find(s => s.name === name);
        if (match) setSkillFiles(match.files);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [name]);

  const loadFile = async (filePath: string) => {
    if (filePath === 'SKILL.md' && skill) {
      setActiveFile('SKILL.md');
      setFileContent(skill.content);
      return;
    }
    setFileLoading(true);
    setActiveFile(filePath);
    try {
      const data = await api.getSkillFile(name, filePath);
      setFileContent(data.content);
    } catch (e) {
      setFileContent(`Error loading file: ${e}`);
    } finally {
      setFileLoading(false);
    }
  };

  const handleSave = async (content: string) => {
    await api.updateSkill(name, content);
  };

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (error) return (
    <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error}</div>
  );

  if (!skill) return null;

  const fileTree = buildFileTree(skillFiles);
  const rootFiles = fileTree[''] || [];
  const dirs = Object.keys(fileTree).filter(k => k !== '');

  return (
    <div className="flex flex-col h-full space-y-4" style={{ minHeight: 'calc(100vh - 3rem)' }}>
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex items-center gap-2 flex-1">
          <h1 className="text-xl font-bold text-white">{skill.name}</h1>
          <Badge variant={skill.source === 'workspace' ? 'workspace' : 'system'}>
            {skill.source}
          </Badge>
          <span className="text-xs text-slate-500">{skillFiles.length} files</span>
        </div>
      </div>

      <div className="flex gap-4 flex-1" style={{ minHeight: '600px' }}>
        {/* File tree sidebar */}
        <div className="w-64 shrink-0 bg-slate-800/60 border border-slate-700/50 rounded-xl p-3 overflow-y-auto">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Files</div>
          
          {/* Root files */}
          {rootFiles.map(f => (
            <button
              key={f}
              onClick={() => loadFile(f)}
              className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 transition-colors ${
                activeFile === f
                  ? 'bg-amber-500/20 text-amber-300'
                  : 'text-slate-300 hover:bg-slate-700/50 hover:text-white'
              }`}
            >
              <span className="text-xs">{getFileIcon(f)}</span>
              <span className="truncate">{f}</span>
            </button>
          ))}

          {/* Directories */}
          {dirs.sort().map(dir => (
            <div key={dir} className="mt-3">
              <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                <FolderOpen className="w-3.5 h-3.5" />
                {dir}
              </div>
              {fileTree[dir]!.sort().map(f => {
                const displayName = f.split('/').pop() || f;
                return (
                  <button
                    key={f}
                    onClick={() => loadFile(f)}
                    className={`w-full text-left px-2 py-1.5 pl-5 rounded text-sm flex items-center gap-2 transition-colors ${
                      activeFile === f
                        ? 'bg-amber-500/20 text-amber-300'
                        : 'text-slate-300 hover:bg-slate-700/50 hover:text-white'
                    }`}
                  >
                    <span className="text-xs">{getFileIcon(displayName)}</span>
                    <span className="truncate">{displayName}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* File content */}
        <div className="flex-1 bg-slate-800/60 border border-slate-700/50 rounded-xl p-5 overflow-hidden">
          <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-700/50">
            <span className="text-xs">{getFileIcon(activeFile)}</span>
            <code className="text-sm text-slate-300 font-mono">{activeFile}</code>
            {fileLoading && (
              <div className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin ml-2" />
            )}
          </div>
          <div className="h-full" style={{ minHeight: '550px' }}>
            {activeFile === 'SKILL.md' ? (
              <SkillEditor
                content={fileContent}
                readOnly={skill.source !== 'workspace'}
                onSave={skill.source === 'workspace' ? handleSave : undefined}
              />
            ) : (
              <pre className="text-sm text-slate-300 font-mono whitespace-pre-wrap overflow-auto h-full p-2 bg-slate-900/50 rounded-lg">
                {fileContent}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
