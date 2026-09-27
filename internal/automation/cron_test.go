package automation

import (
	"testing"
	"time"
)

func TestStandardCronUsesUTCAndSupportsNamesRangesAndSteps(t *testing.T) {
	schedule, err := parseSchedule("*/15 9-10 * JAN,MAR MON-FRI")
	if err != nil {
		t.Fatal(err)
	}
	after := time.Date(2026, time.January, 2, 8, 59, 0, 0, time.UTC)
	if got, want := schedule.Next(after), time.Date(2026, time.January, 2, 9, 0, 0, 0, time.UTC); !got.Equal(want) {
		t.Fatalf("next Cron time = %s, want %s", got, want)
	}
}

func TestCronRejectsNonStandardFieldsAndDescriptors(t *testing.T) {
	for _, value := range []string{
		"*/5 * * * * *",
		"0 0 1 * * 2026",
		"@hourly",
		"CRON_TZ=America/New_York 0 * * * *",
		"? * * * *",
		"invalid cron",
	} {
		t.Run(value, func(t *testing.T) {
			if _, err := parseSchedule(value); err == nil {
				t.Fatalf("parseSchedule(%q) unexpectedly succeeded", value)
			}
		})
	}
}

func TestCronStandardBoundaryMatrix(t *testing.T) {
	tests := []struct {
		name  string
		expr  string
		after time.Time
		want  time.Time
	}{
		{
			name:  "leading zeroes use decimal values",
			expr:  "001 00 01 jan 007",
			after: time.Date(2025, time.December, 31, 23, 59, 0, 0, time.UTC),
			want:  time.Date(2026, time.January, 1, 0, 1, 0, 0, time.UTC),
		},
		{
			name:  "zero weekday is Sunday",
			expr:  "0 0 * * 0",
			after: time.Date(2026, time.January, 3, 0, 0, 0, 0, time.UTC),
			want:  time.Date(2026, time.January, 4, 0, 0, 0, 0, time.UTC),
		},
		{
			name:  "seven weekday is Sunday",
			expr:  "0 0 * * 7",
			after: time.Date(2026, time.January, 3, 0, 0, 0, 0, time.UTC),
			want:  time.Date(2026, time.January, 4, 0, 0, 0, 0, time.UTC),
		},
		{
			name:  "named weekdays ignore case",
			expr:  "0 0 * * mOn",
			after: time.Date(2026, time.January, 4, 0, 0, 0, 0, time.UTC),
			want:  time.Date(2026, time.January, 5, 0, 0, 0, 0, time.UTC),
		},
		{
			name:  "positive decimal step may exceed field span",
			expr:  "*/61 * * * *",
			after: time.Date(2026, time.January, 1, 12, 0, 1, 0, time.UTC),
			want:  time.Date(2026, time.January, 1, 13, 0, 0, 0, time.UTC),
		},
		{
			name:  "positive decimal values accept an explicit plus sign",
			expr:  "+1 0 * * *",
			after: time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC),
			want:  time.Date(2026, time.January, 1, 0, 1, 0, 0, time.UTC),
		},
		{
			name:  "wildcard day of month and restricted weekday use AND",
			expr:  "0 0 * * MON",
			after: time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC),
			want:  time.Date(2026, time.January, 5, 0, 0, 0, 0, time.UTC),
		},
		{
			name:  "both restricted day fields use OR",
			expr:  "0 0 1 * MON",
			after: time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC),
			want:  time.Date(2026, time.January, 5, 0, 0, 0, 0, time.UTC),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			schedule, err := parseSchedule(test.expr)
			if err != nil {
				t.Fatal(err)
			}
			if got := schedule.Next(test.after); !got.Equal(test.want) {
				t.Fatalf("Next(%s) = %s, want %s", test.after, got, test.want)
			}
		})
	}
}

func TestCronUnreachableDateHasNoNextWithinGregorianCycle(t *testing.T) {
	schedule, err := parseSchedule("0 0 31 FEB *")
	if err != nil {
		t.Fatal(err)
	}
	if got := schedule.Next(time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)); !got.IsZero() {
		t.Fatalf("unreachable schedule returned %s", got)
	}
}
