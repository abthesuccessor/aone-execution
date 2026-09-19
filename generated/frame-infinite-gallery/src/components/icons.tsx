type IconProps = { readonly title?: string };

export function SearchIcon({ title }: IconProps) {
  return <svg viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}><title>{title}</title><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>;
}

export function BookmarkIcon({ title }: IconProps) {
  return <svg viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}><title>{title}</title><path d="M6.5 4.5h11v16L12 17l-5.5 3.5z"/></svg>;
}

export function GridIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><rect x="14" y="14" width="6" height="6"/></svg>;
}
