package automation

import (
	"strconv"
	"strings"
	"time"
)

type cronSchedule struct {
	minute cronField
	hour   cronField
	day    cronField
	month  cronField
	week   cronField
}

type cronField struct {
	selected          []bool
	wildcardSpecified bool
}

func parseSchedule(expression string) (cronSchedule, error) {
	fields := strings.Fields(strings.TrimSpace(expression))
	if len(fields) != 5 || len(expression) > 128 || strings.Contains(expression, "?") {
		return cronSchedule{}, invalidField("/cron", "invalidCron", "Use a standard five-field Cron expression in UTC.")
	}
	limits := [][2]int{{0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 7}}
	monthNames := map[string]int{"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6, "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12}
	weekNames := map[string]int{"SUN": 0, "MON": 1, "TUE": 2, "WED": 3, "THU": 4, "FRI": 5, "SAT": 6}
	nameSets := []map[string]int{nil, nil, nil, monthNames, weekNames}
	result := cronSchedule{}
	values := []*cronField{&result.minute, &result.hour, &result.day, &result.month, &result.week}
	for index, field := range fields {
		parsed, ok := parseCronField(field, limits[index][0], limits[index][1], nameSets[index], index == 4)
		if !ok {
			return cronSchedule{}, invalidField("/cron", "invalidCron", "Use valid numeric, list, range, step, or named Cron fields.")
		}
		*values[index] = parsed
	}
	return result, nil
}

func parseCronField(value string, minimum, maximum int, names map[string]int, sundayAlias bool) (cronField, bool) {
	field := cronField{selected: make([]bool, maximum+1)}
	parts := strings.Split(value, ",")
	if len(parts) == 0 {
		return cronField{}, false
	}
	for _, part := range parts {
		if part == "" {
			return cronField{}, false
		}
		base, step := part, 1
		if strings.Contains(part, "/") {
			split := strings.Split(part, "/")
			if len(split) != 2 {
				return cronField{}, false
			}
			base = split[0]
			parsedStep, err := strconv.Atoi(split[1])
			if err != nil || parsedStep < 1 {
				return cronField{}, false
			}
			step = parsedStep
		}
		if base == "" {
			return cronField{}, false
		}
		if strings.HasPrefix(base, "*") {
			field.wildcardSpecified = true
		}
		start, end := minimum, maximum
		if base != "*" {
			bounds := strings.Split(base, "-")
			if len(bounds) > 2 {
				return cronField{}, false
			}
			var ok bool
			start, ok = cronValue(bounds[0], names)
			if !ok {
				return cronField{}, false
			}
			end = start
			if len(bounds) == 2 {
				end, ok = cronValue(bounds[1], names)
				if !ok {
					return cronField{}, false
				}
			} else if len(strings.Split(part, "/")) == 2 {
				end = maximum
			}
		}
		if start < minimum || end > maximum || end < start {
			return cronField{}, false
		}
		for selected := start; selected <= end; {
			if sundayAlias && selected == 7 {
				field.selected[0] = true
			} else {
				field.selected[selected] = true
			}
			if end-selected < step {
				break
			}
			selected += step
		}
	}
	return field, true
}

func cronValue(value string, names map[string]int) (int, bool) {
	if len(value) == 3 && names != nil {
		if parsed, exists := names[strings.ToUpper(value)]; exists {
			return parsed, true
		}
	}
	parsed, err := strconv.Atoi(value)
	return parsed, err == nil
}

func (field cronField) has(value int) bool {
	return value >= 0 && value < len(field.selected) && field.selected[value]
}

func (schedule cronSchedule) Next(after time.Time) time.Time {
	start := after.UTC().Truncate(time.Minute).Add(time.Minute)
	day := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, time.UTC)
	for days := 0; days <= 146097; days++ {
		if schedule.month.has(int(day.Month())) && schedule.matchesDay(day) {
			for hour := 0; hour < 24; hour++ {
				if !schedule.hour.has(hour) {
					continue
				}
				for minute := 0; minute < 60; minute++ {
					if !schedule.minute.has(minute) {
						continue
					}
					candidate := time.Date(day.Year(), day.Month(), day.Day(), hour, minute, 0, 0, time.UTC)
					if !candidate.Before(start) {
						return candidate
					}
				}
			}
		}
		day = day.AddDate(0, 0, 1)
	}
	return time.Time{}
}

func (schedule cronSchedule) matchesDay(day time.Time) bool {
	dayOfMonth := schedule.day.has(day.Day())
	dayOfWeek := schedule.week.has(int(day.Weekday()))
	if schedule.day.wildcardSpecified || schedule.week.wildcardSpecified {
		return dayOfMonth && dayOfWeek
	}
	return dayOfMonth || dayOfWeek
}
