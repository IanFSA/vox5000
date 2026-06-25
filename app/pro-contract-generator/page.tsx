import type { Metadata } from 'next';
import ContractGenerator from '@/components/ContractGenerator';
import SiteFooter from '@/components/SiteFooter';

export const metadata: Metadata = {
  title: 'Contract Generator | BizDocKit Pro',
  description: 'Generate a basic freelance service agreement PDF.',
  robots: { index: true, follow: true },
};

export default function Page() {
  return (
    <main className="min-h-screen bg-[#f6f8fb]">
      <ContractGenerator />
      <SiteFooter />
    </main>
  );
}
