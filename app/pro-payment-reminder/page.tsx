import type { Metadata } from 'next';
import PaymentReminder from '@/components/PaymentReminder';
import SiteFooter from '@/components/SiteFooter';

export const metadata: Metadata = {
  title: 'Payment Reminder Composer | BizDocKit Pro',
  description: 'Generate professional payment reminder emails for overdue invoices.',
  robots: { index: true, follow: true },
};

export default function Page() {
  return (
    <main className="min-h-screen bg-[#f6f8fb]">
      <PaymentReminder />
      <SiteFooter />
    </main>
  );
}
