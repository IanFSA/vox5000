'use client';

import { useEffect, useState } from 'react';
import jsPDF from 'jspdf';
import ProGate from '@/components/ProGate';

interface ContractData {
  contractDate: string;
  providerName: string;
  providerAddress: string;
  providerEmail: string;
  clientName: string;
  clientCompany: string;
  clientAddress: string;
  projectTitle: string;
  services: string;
  startDate: string;
  endDate: string;
  fee: string;
  paymentTerms: string;
  revisions: string;
  ipClause: string;
  terminationClause: string;
  governingLaw: string;
  accentColor: string;
}

const empty: ContractData = {
  contractDate: new Date().toISOString().split('T')[0],
  providerName: '',
  providerAddress: '',
  providerEmail: '',
  clientName: '',
  clientCompany: '',
  clientAddress: '',
  projectTitle: '',
  services: '',
  startDate: '',
  endDate: '',
  fee: '',
  paymentTerms: 'A 50% deposit is due before work commences. The remaining 50% is due upon project completion, before final files are delivered.',
  revisions: 'This agreement includes up to 2 rounds of revisions. Additional revision rounds are charged at the agreed hourly rate.',
  ipClause: 'All intellectual property rights in the final deliverables transfer to the Client upon receipt of full payment. The Provider retains rights to all work-in-progress and preliminary materials.',
  terminationClause: 'Either party may terminate this agreement with 14 days written notice. In the event of termination, the Client shall pay for all work completed to date.',
  governingLaw: '',
  accentColor: '#0A0F1E',
};

const STORAGE_KEY = 'bizdockit_contract_v1';
const inputCls = 'w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100';
const textareaCls = inputCls + ' resize-none';

function field(label: string, el: React.ReactNode, note?: string) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</label>
      {el}
      {note && <p className="mt-1 text-xs text-slate-400">{note}</p>}
    </div>
  );
}

export default function ContractGenerator() {
  const [data, setData] = useState<ContractData>(empty);

  useEffect(() => {
    try { const s = localStorage.getItem(STORAGE_KEY); if (s) setData(JSON.parse(s)); } catch { /* ignore */ }
  }, []);

  function set<K extends keyof ContractData>(k: K, v: ContractData[K]) {
    setData(prev => {
      const next = { ...prev, [k]: v };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  function hexToRgb(hex: string): [number, number, number] {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }

  function generatePdf() {
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const m = 56;
    const cw = pw - m * 2;
    const [ar, ag, ab] = hexToRgb(data.accentColor);

    // Title page style header
    doc.setFillColor(ar, ag, ab);
    doc.rect(0, 0, pw, 110, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(24);
    doc.setTextColor(255, 255, 255);
    doc.text('SERVICE AGREEMENT', m, 48);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    doc.text(data.projectTitle || 'Project Title', m, 68);
    doc.text(`Date: ${data.contractDate}`, pw - m, 60, { align: 'right' });

    let y = 140;

    function heading(title: string) {
      if (y > ph - 100) { doc.addPage(); y = 56; }
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(ar, ag, ab);
      doc.text(title, m, y);
      y += 4;
      doc.setDrawColor(ar, ag, ab);
      doc.line(m, y, pw - m, y);
      y += 14;
    }

    function body(text: string) {
      if (!text.trim()) return;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(40, 40, 40);
      const lines = doc.splitTextToSize(text, cw);
      lines.forEach((line: string) => {
        if (y > ph - 60) { doc.addPage(); y = 56; }
        doc.text(line, m, y);
        y += 14;
      });
      y += 8;
    }

    heading('PARTIES');
    body(`This Service Agreement ("Agreement") is entered into on ${data.contractDate} between:\n\nService Provider: ${data.providerName}${data.providerAddress ? ', ' + data.providerAddress : ''}${data.providerEmail ? ' (' + data.providerEmail + ')' : ''}\n\nClient: ${data.clientName}${data.clientCompany ? ', ' + data.clientCompany : ''}${data.clientAddress ? ', ' + data.clientAddress : ''}`);

    heading('SCOPE OF SERVICES');
    body(data.services || 'The Service Provider agrees to provide the following services: [describe services]');

    heading('PROJECT TIMELINE');
    body(`Start date: ${data.startDate || '[Start date]'}\nCompletion date: ${data.endDate || '[End date]'}`);

    heading('FEES AND PAYMENT');
    body(`Project fee: ${data.fee || '[Fee]'}\n\n${data.paymentTerms}`);

    heading('REVISIONS');
    body(data.revisions);

    heading('INTELLECTUAL PROPERTY');
    body(data.ipClause);

    heading('TERMINATION');
    body(data.terminationClause);

    if (data.governingLaw) {
      heading('GOVERNING LAW');
      body(`This Agreement shall be governed by the laws of ${data.governingLaw}.`);
    }

    heading('SIGNATURES');
    body('By signing below, both parties agree to the terms of this Agreement.');

    y += 10;
    doc.setDrawColor(180, 180, 180);
    doc.line(m, y + 30, m + 180, y + 30);
    doc.line(pw - m - 180, y + 30, pw - m, y + 30);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(100, 100, 100);
    doc.text(data.providerName || 'Service Provider', m, y + 44);
    doc.text('Date: _______________', m, y + 58);
    doc.text(data.clientName || 'Client', pw - m - 180, y + 44);
    doc.text('Date: _______________', pw - m - 180, y + 58);

    doc.setFontSize(7.5);
    doc.setTextColor(180, 180, 180);
    doc.text('Generated with BizDocKit Pro · bizdockit.com · This is a template only — not legal advice. Have a lawyer review before use.', pw / 2, ph - 18, { align: 'center' });

    doc.save('service-agreement.pdf');
  }

  return (
    <ProGate toolName="Contract Generator">
      <section className="mx-auto max-w-7xl px-6 py-12 lg:px-8">
        <div className="mb-8">
          <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-bold uppercase tracking-widest text-amber-700">Pro tool</span>
          <h1 className="mt-3 text-4xl font-bold tracking-[-0.03em] text-[#0A0F1E]">Contract Generator</h1>
          <p className="mt-2 text-slate-500">Generate a basic freelance service agreement. Download as PDF. <span className="font-semibold text-amber-600">Template only — not legal advice.</span></p>
        </div>

        <div className="grid gap-8 lg:grid-cols-[420px_1fr]">
          <div className="space-y-5 rounded-3xl border border-slate-200 bg-white p-6">
            {field('Contract date', <input type="date" className={inputCls} value={data.contractDate} onChange={e => set('contractDate', e.target.value)} />)}

            <div className="border-t border-slate-100 pt-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Your details</p>
              {field('Your full name', <input className={inputCls} value={data.providerName} onChange={e => set('providerName', e.target.value)} placeholder="Jane Smith" />)}
              {field('Your address', <input className={inputCls} value={data.providerAddress} onChange={e => set('providerAddress', e.target.value)} placeholder="123 Main St, Johannesburg" />)}
              {field('Your email', <input className={inputCls} value={data.providerEmail} onChange={e => set('providerEmail', e.target.value)} placeholder="jane@yourbiz.com" />)}
            </div>

            <div className="border-t border-slate-100 pt-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Client details</p>
              {field('Client name', <input className={inputCls} value={data.clientName} onChange={e => set('clientName', e.target.value)} placeholder="John Client" />)}
              {field('Client company', <input className={inputCls} value={data.clientCompany} onChange={e => set('clientCompany', e.target.value)} placeholder="Acme Corp" />)}
              {field('Client address', <input className={inputCls} value={data.clientAddress} onChange={e => set('clientAddress', e.target.value)} placeholder="456 Client St" />)}
            </div>

            <div className="border-t border-slate-100 pt-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Project</p>
              {field('Project title', <input className={inputCls} value={data.projectTitle} onChange={e => set('projectTitle', e.target.value)} placeholder="Website Redesign" />)}
              {field('Services description', <textarea className={textareaCls} rows={3} value={data.services} onChange={e => set('services', e.target.value)} placeholder="Describe what you will deliver." />)}
              <div className="grid grid-cols-2 gap-3">
                {field('Start date', <input type="date" className={inputCls} value={data.startDate} onChange={e => set('startDate', e.target.value)} />)}
                {field('End date', <input type="date" className={inputCls} value={data.endDate} onChange={e => set('endDate', e.target.value)} />)}
              </div>
              {field('Fee', <input className={inputCls} value={data.fee} onChange={e => set('fee', e.target.value)} placeholder="R 15,000" />)}
            </div>

            <div className="border-t border-slate-100 pt-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Terms (edit as needed)</p>
              {field('Payment terms', <textarea className={textareaCls} rows={3} value={data.paymentTerms} onChange={e => set('paymentTerms', e.target.value)} />)}
              {field('Revisions', <textarea className={textareaCls} rows={2} value={data.revisions} onChange={e => set('revisions', e.target.value)} />)}
              {field('IP clause', <textarea className={textareaCls} rows={3} value={data.ipClause} onChange={e => set('ipClause', e.target.value)} />)}
              {field('Termination', <textarea className={textareaCls} rows={2} value={data.terminationClause} onChange={e => set('terminationClause', e.target.value)} />)}
              {field('Governing law', <input className={inputCls} value={data.governingLaw} onChange={e => set('governingLaw', e.target.value)} placeholder="South Africa" />, 'e.g. South Africa, United Kingdom')}
            </div>

            {field('Accent colour', <input type="color" className="h-10 w-full cursor-pointer rounded-xl border border-slate-200 p-1" value={data.accentColor} onChange={e => set('accentColor', e.target.value)} />)}

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-700">
              ⚠️ This is a starting template only. It is not legal advice. Always have a qualified lawyer review any contract before use.
            </div>

            <button type="button" onClick={generatePdf} className="w-full rounded-2xl bg-[#0A0F1E] px-6 py-4 text-sm font-bold text-white transition hover:bg-[#1a2030]">
              Download Contract PDF →
            </button>
          </div>

          {/* Preview */}
          <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6">
            <p className="mb-4 text-xs font-bold uppercase tracking-widest text-slate-400">Preview</p>
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="px-8 py-6" style={{ backgroundColor: data.accentColor }}>
                <p className="text-2xl font-black text-white">SERVICE AGREEMENT</p>
                <p className="mt-1 text-sm text-white/70">{data.projectTitle || 'Project Title'}</p>
                <p className="text-xs text-white/50">{data.contractDate}</p>
              </div>
              <div className="space-y-5 p-8 text-sm">
                {[
                  { title: 'Parties', body: `${data.providerName || '[Provider]'} and ${data.clientName || '[Client]'}` },
                  { title: 'Services', body: data.services || '[Services description]' },
                  { title: 'Fee', body: data.fee || '[Fee]' },
                  { title: 'Payment terms', body: data.paymentTerms },
                  { title: 'Governing law', body: data.governingLaw || '[Country]' },
                ].map(({ title, body }) => (
                  <div key={title}>
                    <p className="mb-1 text-xs font-bold uppercase tracking-widest" style={{ color: data.accentColor }}>{title}</p>
                    <p className="text-slate-600">{body}</p>
                  </div>
                ))}
                <div className="grid grid-cols-2 gap-8 border-t border-slate-100 pt-6">
                  <div>
                    <div className="mb-2 border-b border-slate-300" style={{ paddingBottom: 24 }} />
                    <p className="text-xs text-slate-500">{data.providerName || 'Service Provider'}</p>
                  </div>
                  <div>
                    <div className="mb-2 border-b border-slate-300" style={{ paddingBottom: 24 }} />
                    <p className="text-xs text-slate-500">{data.clientName || 'Client'}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </ProGate>
  );
}
