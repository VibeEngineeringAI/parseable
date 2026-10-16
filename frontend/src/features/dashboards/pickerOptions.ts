export type DatasetOption = { value: string; label?: string };

/**
 * Options for a dataset picker: an explicit empty choice first, then the saved
 * selection when discovery does not list it, then deduplicated choices. The
 * saved value is only marked unavailable once discovery has succeeded, so a
 * loading or failed list never mislabels it.
 */
export function datasetOptions({
  choices,
  selected,
  emptyLabel,
  loaded,
}: {
  choices: ReadonlyArray<string>;
  selected?: string | null;
  emptyLabel: string;
  loaded: boolean;
}): DatasetOption[] {
  const unique = [...new Set(choices.filter(Boolean))];
  return [
    { value: '', label: emptyLabel },
    ...(selected && !unique.includes(selected)
      ? [loaded ? { value: selected, label: `${selected} (unavailable)` } : { value: selected }]
      : []),
    ...unique.map((value) => ({ value })),
  ];
}
