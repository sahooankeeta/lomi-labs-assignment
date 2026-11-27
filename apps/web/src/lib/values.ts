import type { ValueDto } from '@lomi/shared';

/**
 * Splits values into the three review groups shown on the detail page. Pending values
 * (gaps included) need attention; carried-over ones await a look; approved/corrected are
 * done. Input order (field order) is kept inside each group.
 */
export function groupValues(values: ValueDto[]): {
  attention: ValueDto[];
  carried: ValueDto[];
  done: ValueDto[];
} {
  return {
    attention: values.filter((v) => v.reviewState === 'pending'),
    carried: values.filter((v) => v.reviewState === 'carried_over'),
    done: values.filter((v) => v.reviewState === 'approved' || v.reviewState === 'corrected'),
  };
}

/**
 * The value a reviewer has settled on: the correction if the newest review corrected it,
 * otherwise the extracted value (null for a gap).
 */
export function effectiveValue(v: ValueDto): string | null {
  return v.reviewState === 'corrected' ? (v.latestReview?.correctedValue ?? null) : v.value;
}
