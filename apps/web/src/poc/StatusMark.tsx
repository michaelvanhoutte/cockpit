/** POC (throwaway): a status mark the way a row's reads - a ring, a half, a tick. */
export function StatusMark({ status }: { status: 'to_do' | 'in_progress' | 'waiting' | 'done' }) {
  if (status === 'done')
    return (
      <span aria-label="Done" className="flex size-4 shrink-0 items-center justify-center rounded-full bg-cat-green text-[10px] text-white">
        ✓
      </span>
    );
  if (status === 'in_progress' || status === 'waiting')
    return (
      <span
        aria-label={status === 'waiting' ? 'Waiting' : 'In progress'}
        className="size-4 shrink-0 rounded-full border-2 border-accent"
        style={{ background: 'linear-gradient(90deg, var(--color-accent) 50%, transparent 50%)' }}
      />
    );
  return <span aria-label="To do" className="size-4 shrink-0 rounded-full border-2 border-shade/30" />;
}

