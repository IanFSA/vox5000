import type { Metadata } from 'next';
import ExpenseTracker from '@/components/ExpenseTracker';
import SiteFooter from '@/components/SiteFooter';

export const metadata: Metadata = {
  title: 'Expense Tracker | BizDocKit Pro',
  description: 'Track business expenses by category and export a clean PDF report.',
  robots: { index: true, follow: true },
};

export default function Page() {
  return (
    <main className="min-h-screen bg-[#f6f8fb]">
      <ExpenseTracker />
      <SiteFooter />
    </main>
  );
}
