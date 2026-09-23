# Modelry Product Experience and Acceptance

## Why this document exists

Modelry's success depends on productization.

A technically correct backend can still fail if the user cannot discover the right action, understand the current state, recover from errors or complete a workflow without reading implementation documentation.

## Product experience rules

### One clear job per page

Every page must answer a user question.

Examples:

- Overview: is my backend healthy and what needs attention?
- Collections: what data models exist?
- Records: what real data exists?
- Schema: what is the structure?
- Changes: what is about to change and what happened?
- API: what can my application call and what requests actually happened?
- Hooks: what code extends runtime behavior and is it healthy?
- Access: who can manage Modelry and what was audited?
- Activity: what operational events need attention?

### One obvious primary action

A work surface should not present five equally strong buttons.

Secondary actions belong in context menus, row actions or secondary toolbars.

### Default to the common path

The common path must work without advanced configuration.

Advanced database, runtime and security features use progressive disclosure.

### Durable result, not Toast-only success

After a mutation, the resulting object/state remains visible.

A Toast may confirm success but cannot be the only evidence.

### Actionable errors

Errors should answer:

- what failed;
- why;
- what is affected;
- whether anything was persisted;
- what the user can do next;
- where to navigate for recovery.

### Safe destructive actions

Destructive schema/data/runtime operations require appropriate confirmation and visible impact.

Risk is calculated by the runtime, not entered by the user.

### Empty states teach the product

An empty state should explain the purpose, show the next action and avoid decorative noise.

### Progressive complexity

Users should not need to understand SQLite WAL, migration internals, principal types or event durability to perform ordinary work.

Advanced explanations remain available where diagnostic value exists.

## Visual product standard

Admin must use one Design System for:

- typography;
- spacing;
- buttons;
- forms;
- tables;
- cards;
- drawers/sheets;
- dialogs;
- tabs;
- status indicators;
- empty states;
- errors;
- destructive confirmations.

Avoid the visual feel of a generic internal dashboard:

- do not default every page to metric cards;
- do not overuse dense tables when cards provide better discovery;
- do not expose raw IDs or JSON as the main experience;
- do not let each module invent its own interaction patterns.

## Recommended information architecture

Core
- Overview
- Collections
- API

Control
- Changes
- Hooks
- Access

System
- Settings
- Activity.

Collection local navigation:

- Records
- Schema
- Policy
- Auth when applicable
- API.

Schema local views:

- Fields
- Relations
- Indexes.

## State ownership

Use clear state boundaries:

- server state: query/cache layer;
- form state: form library and validation schema;
- URL state: filters, tabs, selections that should deep-link;
- local UI state: transient presentation only.

Do not introduce global state merely to avoid designing ownership.

## Product Definition of Done

Every user-facing feature must satisfy five closures.

### Functional Closure

The intended behavior works through real runtime interfaces.

### UX Closure

The workflow is understandable and efficient.

### Visual Closure

The surface follows the shared Design System and information hierarchy.

### Error Closure

Expected failure modes provide actionable recovery.

### Business Flow Closure

A user can complete the full real task and verify the durable result from another surface.

## Browser Acceptance

Mandatory acceptance uses:

real compiled Modelry runtime
+ real SQLite
+ real HTTP
+ real Admin UI
+ real Chromium.

Do not use mocked backends for mandatory product closure flows.

### Cross-surface verification

Examples:

Create Record
-> record appears in UI
-> API reads it
-> reload preserves it.

Apply ChangeSet
-> ChangeSet Applied
-> Apply Attempt succeeded
-> Schema changed
-> Migration History updated
-> restart preserves the new model.

Auth revoke
-> session management shows revoked state
-> application access fails afterwards.

### Health gates

Mandatory flows should fail on:

- unexpected browser console errors;
- page exceptions;
- unexpected 5xx;
- broken navigation;
- stuck loading state;
- unhandled network failure.

### Interaction quality

Acceptance also checks:

- focus and keyboard behavior;
- loading and disabled states;
- empty/error states;
- obvious next action;
- stable layout;
- no duplicate submissions;
- deep links where expected.

A passing API suite alone is not product acceptance.
