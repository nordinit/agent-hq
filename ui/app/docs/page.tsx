import { redirect } from 'next/navigation';
import { API_DOCS_ROUTE } from '@/lib/docsRoute';

export default function LegacyApiDocsPage() {
  redirect(API_DOCS_ROUTE);
}
