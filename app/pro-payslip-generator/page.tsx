import type { Metadata } from 'next';
import PayslipGenerator from '@/components/PayslipGenerator';
import SiteFooter from '@/components/SiteFooter';

export const metadata: Metadata = {
  title: 'Payslip Generator | BizDocKit Pro',
  description: 'Create a professional payslip PDF for your employees.',
  robots: { index: true, follow: true },
};

export default function Page() {
  return (
    <main className="min-h-screen bg-[#f6f8fb]">
      <PayslipGenerator />
      <SiteFooter />
    </main>
  );
}
