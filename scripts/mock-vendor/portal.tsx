/* eslint-disable @next/next/no-head-element, @next/next/no-css-tags, @next/next/no-html-link-for-pages -- Static HTML for an independent fixture, not a Next.js route. */
import React from "react";
import { FileDown, FileText, LayoutPanelLeft, RotateCcw } from "lucide-react";
import { Button } from "../../components/ui/button";
import { amount, invoicesFor } from "../../docker/desktop/mock-vendor/fixtures.mjs";

const field = "h-8 rounded-md border border-input bg-surface px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
export function Portal({ layout, month }: { layout: "a" | "b"; month: string }) {
  const invoices = invoicesFor(month);
  const link = (id: string) => <Button asChild variant="secondary"><a href={`/invoices/${id}.pdf`} download><FileDown size={16} aria-hidden="true" />{layout === "a" ? "Download PDF" : "Get invoice"}</a></Button>;
  return <html lang="en"><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="csrf-token" content="__DEMO_CSRF__" /><title>Eclipse Demo Supply · Invoices</title>
    <link rel="stylesheet" href="/portal.css" /><script src="/client.js" defer /></head>
    <body className="min-h-screen bg-background text-foreground text-sm">
      <header className="border-b border-border px-4 py-4 md:px-8"><div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
        <a href="/" className="flex items-center gap-2 font-semibold underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><FileText size={20} aria-hidden="true" />Eclipse Demo Supply</a>
        <span className="text-xs text-muted-foreground">Synthetic data · No payment required</span>
      </div></header>
      <div className={`mx-auto max-w-6xl ${layout === "b" ? "md:grid md:grid-cols-[260px_1fr]" : ""}`}>
        <nav aria-label="Vendor navigation" className={layout === "a" ? "border-b border-border px-4 py-4 md:px-8" : "border-b border-border p-4 md:min-h-screen md:border-b-0 md:border-r md:p-6"}>
          <a aria-current="page" href={`/?month=${month}`} className="font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">{layout === "a" ? "Invoices" : "Billing"}</a>
          {layout === "b" && <p className="mt-4 text-muted-foreground">Your invoices and billing documents, in one place.</p>}
        </nav>
        <main id="main" data-layout={layout} className="min-w-0 p-4 md:p-8">
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{layout === "a" ? "Invoices" : "Billing documents"}</h1>
          <p className="mt-2 text-muted-foreground">Find and download your invoice PDFs.</p>
          <form method="get" className="mt-6 flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-2"><label htmlFor="month" className="font-medium">{layout === "a" ? "Invoice month" : "Billing period"}</label>
              <select id="month" name="month" defaultValue={month} className={field}>
                <option value="all">All months</option><option value="2026-09">September 2026</option><option value="2026-10">October 2026</option><option value="2026-11">November 2026</option><option value="2026-12">December 2026</option>
              </select></div><Button type="submit">Apply filter</Button>
          </form>
          <p className="mt-4 text-xs text-muted-foreground tabular-nums">{invoices.length} {invoices.length === 1 ? "invoice" : "invoices"} · {amount(invoices.reduce((sum, invoice) => sum + invoice.cents, 0))}</p>
          {!invoices.length ? <section className="mt-6 rounded-lg border border-border bg-surface p-6"><h2 className="text-lg font-semibold">No invoices for this month</h2><p className="mt-2 text-muted-foreground">Choose another month to see its documents.</p><Button asChild variant="link" className="mt-4"><a href="/?month=all">Clear filters</a></Button></section>
            : layout === "a" ? <div className="mt-6 overflow-x-auto rounded-lg border border-border"><table className="w-full text-left"><caption className="sr-only">Synthetic invoices</caption>
              <thead className="border-b border-border-strong bg-surface text-xs text-muted-foreground"><tr>{["Invoice", "Date", "Total", "Status", "Document"].map((name) => <th key={name} scope="col" className="h-10 px-3 font-medium">{name}</th>)}</tr></thead>
              <tbody>{invoices.map((invoice) => <tr key={invoice.id} className="border-b border-border last:border-0"><th scope="row" className="px-3 py-1 font-mono text-xs font-medium">{invoice.id}</th><td className="px-3 py-1 font-mono text-xs">{invoice.date}</td><td className="px-3 py-1 font-mono text-xs tabular-nums whitespace-nowrap">{amount(invoice.cents)}</td><td className="px-3 py-1 text-xs">{invoice.status}</td><td className="px-3 py-1">{link(invoice.id)}</td></tr>)}</tbody>
            </table></div> : <section aria-label="Invoices" className="mt-6 grid gap-4">{invoices.map((invoice) => <article key={invoice.id} className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-surface p-4"><div><h2 className="font-mono text-base font-semibold">{invoice.id}</h2><p className="mt-2 font-mono text-xs text-muted-foreground">{invoice.date}</p></div><div><p className="font-mono text-base tabular-nums">{amount(invoice.cents)}</p><p className="mt-2 text-xs text-muted-foreground">{invoice.status}</p></div>{link(invoice.id)}</article>)}</section>}
          <details className="mt-8 border-t border-border pt-6"><summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Demo controls</summary>
            <p className="mt-4 text-xs text-muted-foreground">Switch the portal layout while keeping the same invoices. Reset returns to layout A and October 2026.</p>
            <div className="mt-4 flex flex-wrap gap-2"><Button type="button" variant="secondary" data-demo-action="layout" data-layout={layout === "a" ? "b" : "a"}><LayoutPanelLeft size={16} aria-hidden="true" />Switch to layout {layout === "a" ? "B" : "A"}</Button>
              <Button type="button" variant="ghost" data-demo-action="reset"><RotateCcw size={16} aria-hidden="true" />Reset demo</Button></div>
            <p id="demo-error" role="alert" className="mt-4 text-danger" hidden /></details>
          <p id="demo-status" role="status" aria-live="polite" className="mt-4 text-xs text-muted-foreground">__DEMO_NOTICE__</p>
        </main>
      </div>
    </body></html>;
}
