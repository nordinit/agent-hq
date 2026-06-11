import ApiDocsPage from '@/features/api-docs-page';

export default function SettingsApiPage() {
  return (
    <div className="flex min-h-full flex-col rounded-lg border border-slate-800 bg-slate-950" data-tour-target="settings-api-main">
      <ApiDocsPage />
    </div>
  );
}
