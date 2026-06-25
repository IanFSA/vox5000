import type { Metadata } from 'next';
import ProposalGenerator from '@/components/ProposalGenerator';
import SiteFooter from '@/components/SiteFooter';

export const metadata: Metadata = {
  title: 'Proposal Generator | BizDocKit Pro',
  description: 'Create a professional project proposal PDF.',
  robots: { index: true, follow: true },
};

export default function Page() {
  return (
    <main className="min-h-screen bg-[#f6f8fb]">
      <ProposalGenerator />
      <SiteFooter />
    </main>
  );
}
