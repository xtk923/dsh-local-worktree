/**
 * The sentences, in both languages.
 *
 * A bilingual string here is one Chinese half and one English half joined by
 * ` / `, so interpolating an ALREADY JOINED string into another one emits both
 * halves twice. That is not hypothetical: a delivery notice shipped reading
 * `已把 2 个提交快进 / fast-forwarded到 main`, and no test noticed because nothing
 * asserted on the sentence a merge actually prints.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { committedText, deliveredText, reasonText } from '../src/text.js';

/** How many language separators a sentence has; more than one means nesting. */
const separators = (text) => String(text).split(' / ').length - 1;

test('deliveredText says fast-forward in both languages, without splicing them', () => {
	const text = deliveredText({ strategy: 'fast-forward', branch: 'dsh/wt/x', base: 'main', commits: 2 });
	assert.equal(
		text,
		'已把 2 个提交快进到 main（来自 dsh/wt/x） / 2 commit(s) fast-forwarded into main from dsh/wt/x'
	);
	assert.equal(separators(text), 1, 'exactly one separator: a nested bilingual pair would produce more');
	assert.equal(/快进 \/ fast-forwarded/.test(text), false, 'a translated fragment never lands inside the other language');
});

test('deliveredText says merge commit in both languages', () => {
	const text = deliveredText({ strategy: 'merge-commit', branch: 'dsh/wt/x', base: 'main', commits: 1 });
	assert.equal(
		text,
		'已把 1 个提交用一个 merge commit 合并到 main（来自 dsh/wt/x） / 1 commit(s) merged with a commit into main from dsh/wt/x'
	);
	assert.equal(separators(text), 1);
});

test('the other sentences keep one separator each', () => {
	for (const text of [
		deliveredText({ strategy: 'fast-forward', branch: 'b', base: 'main', commits: 0 }),
		committedText({ message: 'wip: x', changes: 3 })
	]) {
		assert.equal(separators(text), 1, text);
	}
});

test('a reason can be read in one language without the other leaking in', () => {
	const both = reasonText('worktree-dirty', { lang: 'both' });
	assert.equal(separators(both), 1);
	assert.equal(/worktree 里有未提交改动/.test(reasonText('worktree-dirty', { lang: 'zh' })), true);
	assert.equal(reasonText('worktree-dirty', { lang: 'en' }), 'the worktree has uncommitted changes');
	// An unknown code is reported as itself rather than swallowed: a missing string is
	// a bug, and seeing the code is how it gets noticed.
	assert.equal(reasonText('no-such-reason'), 'no-such-reason');
});
