interface PageHeaderProps {
  readonly title: string;
  readonly description?: string;
  readonly actions?: React.ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-col items-start gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

export function ComingSoon({ feature }: { readonly feature: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/40 p-12 text-center">
      <p className="text-sm text-muted-foreground">
        Раздел &laquo;{feature}&raquo; — заглушка, наполнение в следующем подэтапе.
      </p>
    </div>
  );
}
