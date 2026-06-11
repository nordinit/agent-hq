'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Eye, Code, Save } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface SkillEditorProps {
  content: string;
  readOnly?: boolean;
  onSave?: (content: string) => Promise<void>;
}

export default function SkillEditor({ content: initialContent, readOnly = false, onSave }: SkillEditorProps) {
  const [content, setContent] = useState(initialContent);
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave(content);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-3">
        {!readOnly && (
          <>
            <Button
              variant={mode === 'preview' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setMode('preview')}
            >
              <Eye className="w-3.5 h-3.5" /> Preview
            </Button>
            <Button
              variant={mode === 'edit' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setMode('edit')}
            >
              <Code className="w-3.5 h-3.5" /> Edit
            </Button>
            <div className="flex-1" />
            {mode === 'edit' && (
              <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
                <Save className="w-3.5 h-3.5" />
                {saved ? 'Saved!' : 'Save'}
              </Button>
            )}
          </>
        )}
        {readOnly && (
          <span className="text-xs text-slate-500 bg-slate-700/50 px-2 py-1 rounded">
            System skill — read only
          </span>
        )}
      </div>

      {/* Content */}
      {mode === 'preview' || readOnly ? (
        <div className="prose prose-invert prose-sm max-w-none overflow-auto flex-1
          prose-headings:text-white prose-headings:font-semibold
          prose-p:text-slate-300 prose-li:text-slate-300
          prose-code:text-amber-300 prose-code:bg-slate-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded
          prose-pre:bg-slate-900 prose-pre:border prose-pre:border-slate-700
          prose-a:text-blue-400 prose-blockquote:border-l-slate-600 prose-blockquote:text-slate-400
          prose-strong:text-white prose-hr:border-slate-700
          prose-table:text-slate-300 prose-th:text-white prose-th:border-slate-600 prose-td:border-slate-700
        ">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {content}
          </ReactMarkdown>
        </div>
      ) : (
        <textarea
          className="flex-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-slate-200 text-sm font-mono leading-relaxed focus:outline-none focus:border-amber-500 resize-none"
          value={content}
          onChange={e => setContent(e.target.value)}
          spellCheck={false}
        />
      )}
    </div>
  );
}
