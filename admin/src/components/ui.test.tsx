import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button, Dialog, EmptyState, ErrorState, FormField, LoadingState, PartialState, StatusChip } from './ui';

describe('Admin interface primitives', () => {
  it('exposes the status with its visual state and readable label', () => {
    render(<StatusChip state="ready">Ready</StatusChip>);
    expect(screen.getByText('Ready')).toHaveClass('status-chip--ready');
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

    expect(button).toHaveClass('button--primary');
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('keeps concurrent dialog titles uniquely associated for screen readers', () => {
    render(
      <>
        <Dialog open onClose={() => undefined} title="Record">
          <p>Record details</p>
        </Dialog>
        <Dialog open onClose={() => undefined} title="Delete this record?">
          <button type="button">Delete record</button>
        </Dialog>
      </>,
    );

    const recordDialog = screen.getByRole('dialog', { name: 'Record' });
    const deleteDialog = screen.getByRole('dialog', { name: 'Delete this record?' });
    expect(recordDialog.getAttribute('aria-labelledby')).not.toBe(deleteDialog.getAttribute('aria-labelledby'));
    expect(screen.getByRole('button', { name: 'Delete record' })).toBeInTheDocument();
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
