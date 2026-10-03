import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { FormField } from './form-field';
import { Dialog } from './overlays';
import { EmptyState, ErrorState, LoadingState, PartialState, StatusChip } from './states';

describe('Admin interface primitives', () => {
  it('exposes the status with its visual state and readable label', () => {
    render(<StatusChip state="ready">Ready</StatusChip>);
    expect(screen.getByText('Ready')).toHaveAttribute('data-slot', 'badge');
    expect(screen.getByText('Ready')).toHaveClass('bg-success-soft');
  });

  it('associates a form hint with the input for assistive technology', () => {
    render(
      <FormField htmlFor="project-name" hint="Use a short name." label="Project name">
        <input id="project-name" />
      </FormField>,
    );
    expect(screen.getByLabelText('Project name')).toHaveAccessibleDescription('Use a short name.');
  });

  it('supports the button hierarchy and keyboard activation', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick} variant="primary">Refresh status</Button>);
    const button = screen.getByRole('button', { name: 'Refresh status' });

    button.focus();
    await user.keyboard('{Enter}');

    expect(button).toHaveClass('bg-primary');
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('keeps concurrent dialog titles uniquely associated for screen readers', () => {
    render(
      <>
        <Dialog closeLabel="Close dialog" open onClose={() => undefined} title="Record">
          <p>Record details</p>
        </Dialog>
        <Dialog closeLabel="Close dialog" open onClose={() => undefined} title="Delete this record?">
          <button type="button">Delete record</button>
        </Dialog>
      </>,
    );

    // Assert each modal dialog's accessible title association directly.
    const dialogs = document.body.querySelectorAll<HTMLElement>('[role="dialog"]');
    expect(dialogs.length).toBe(2);
    const first = dialogs[0]!;
    const second = dialogs[1]!;
    const firstLabelledBy = first.getAttribute('aria-labelledby');
    const secondLabelledBy = second.getAttribute('aria-labelledby');
    expect(firstLabelledBy).toBeTruthy();
    expect(firstLabelledBy).not.toBe(secondLabelledBy);
    expect(document.getElementById(firstLabelledBy ?? '')).toHaveTextContent('Record');
    expect(document.getElementById(secondLabelledBy ?? '')).toHaveTextContent('Delete this record?');
    // Both dialogs are open at once; include hidden nodes while checking the second dialog.
    expect(screen.getByRole('button', { name: 'Delete record', hidden: true })).toBeInTheDocument();
  });

  it('offers accessible loading, empty, partial and error states', () => {
    render(
      <>
        <LoadingState label="Checking Runtime" />
        <EmptyState description="Nothing is configured." title="No collections" />
        <PartialState>Storage status is unavailable.</PartialState>
        <ErrorState description="Try again." title="Request failed" />
      </>,
    );

    expect(screen.getByRole('status', { name: 'Checking Runtime' })).toBeInTheDocument();
    expect(screen.getByText('No collections').closest('[role="status"]')).toBeInTheDocument();
    expect(screen.getByText('Storage status is unavailable.').closest('[role="status"]')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Request failed');
  });
});
