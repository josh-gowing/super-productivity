import { isSameSubTaskTemplateContent } from './sub-task-template.util';

describe('isSameSubTaskTemplateContent', () => {
  it('treats identical content as equal', () => {
    expect(
      isSameSubTaskTemplateContent(
        { title: 'Buy milk', timeEstimate: 5, notes: 'note' },
        { title: 'Buy milk', timeEstimate: 5, notes: 'note' },
      ),
    ).toBe(true);
  });

  it('detects a title change', () => {
    expect(isSameSubTaskTemplateContent({ title: 'a' }, { title: 'b' })).toBe(false);
  });

  it('detects a time estimate change', () => {
    expect(
      isSameSubTaskTemplateContent(
        { title: 'a', timeEstimate: 5 },
        { title: 'a', timeEstimate: 10 },
      ),
    ).toBe(false);
  });

  it('treats missing time estimate as 0', () => {
    expect(
      isSameSubTaskTemplateContent({ title: 'a', timeEstimate: 0 }, { title: 'a' }),
    ).toBe(true);
  });

  it('ignores leading/trailing whitespace in notes', () => {
    expect(
      isSameSubTaskTemplateContent(
        { title: 'a', notes: '  hello ' },
        { title: 'a', notes: 'hello' },
      ),
    ).toBe(true);
  });

  it('treats null/undefined/empty notes as equal', () => {
    expect(
      isSameSubTaskTemplateContent(
        { title: 'a', notes: null },
        { title: 'a', notes: '' },
      ),
    ).toBe(true);
    expect(isSameSubTaskTemplateContent({ title: 'a' }, { title: 'a', notes: '' })).toBe(
      true,
    );
  });

  it('detects a notes change', () => {
    expect(
      isSameSubTaskTemplateContent(
        { title: 'a', notes: 'one' },
        { title: 'a', notes: 'two' },
      ),
    ).toBe(false);
  });
});
