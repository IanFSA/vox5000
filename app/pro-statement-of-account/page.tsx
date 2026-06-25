import type { Metadata } from 'next';
import StatementOfAccount from '@/components/StatementOfAccount';
import SiteFooter from '@/components/SiteFooter';

export const metadata: Metadata = {
  title: 'Statement of Account | BizDocKit Pro',
  description: 'Generate a statement showing all outstanding invoices for a client.',
  robots: { index: true, follow: true },
};

export default function Page() {
  return (
    <main className="min-h-screen bg-[#f6f8fb]">
      <StatementOfAccount />
      <SiteFooter />
    </main>
  );
}
