import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequests, findForms, describeRequests, personLabel } from '../src/signal/naturalParser.js';

/** Every request as "rank name -> form, form", which is what a rule acts on. */
function shape(text) {
  return parseRequests(text).requests.map((request) => ({
    person: personLabel(request.person),
    forms: request.forms.map((form) => form.label),
  }));
}

// --------------------------------------------------------------------------
// The eight message shapes this parser was built from -- all real traffic from
// the certificates group. Each one is a different way of saying the same thing.
// --------------------------------------------------------------------------

test('name first, then several forms on the same line', () => {
  assert.deepEqual(
    shape('молодший сержант Іванов Іван Іванович потрібно довідка ф12, довідка ф5 для вихідного контролю.'),
    [{ person: 'молодший сержант Іванов Іван Іванович', forms: ['Форма 12', 'Форма 5'] }]
  );
});

test('a named form, then the person, then a personal number', () => {
  const parsed = parseRequests('Добрий день! Потрібна Довідка в/с (замість ВК), рекрут Іванов Іван Іванович, 123124');
  assert.deepEqual(shape(parsed.text), [
    { person: 'рекрут Іванов Іван Іванович', forms: ['Довідка щодо військовослужбовця'] },
  ]);
  assert.equal(parsed.people[0].personalNumber, '123124');
  // "(замість ВК)" belongs to the form, so it must not be read as a note.
  assert.equal(parsed.people[0].note, null);
});

test('each header form applies only to the people listed under it', () => {
  assert.deepEqual(shape(`Бажаю здоров'я. Потрібно
Ф5:
Березяк Андрій Євгенович
Ф6:
Чапля Руслан Миколайович
Підкуймуха Андрій Степанович`), [
    { person: 'Березяк Андрій Євгенович', forms: ['Форма 5'] },
    { person: 'Чапля Руслан Миколайович', forms: ['Форма 6'] },
    { person: 'Підкуймуха Андрій Степанович', forms: ['Форма 6'] },
  ]);
});

test('header lines with nobody between them are one header', () => {
  assert.deepEqual(shape(`Потрібні ф5
та ф12 на:
Іванов Іван Іванович
Петренко Петро Петрович`), [
    { person: 'Іванов Іван Іванович', forms: ['Форма 5', 'Форма 12'] },
    { person: 'Петренко Петро Петрович', forms: ['Форма 5', 'Форма 12'] },
  ]);
});

test('a header written after the names still applies to them', () => {
  assert.deepEqual(shape(`Іванов Іван Іванович
Петренко Петро Петрович
потрібна ф6`), [
    { person: 'Іванов Іван Іванович', forms: ['Форма 6'] },
    { person: 'Петренко Петро Петрович', forms: ['Форма 6'] },
  ]);
});

test('one form as a header, then a person per line', () => {
  assert.deepEqual(shape('І ще ф5 на:\nІванов Іван Іванович\nПетренко Іван Іванович'), [
    { person: 'Іванов Іван Іванович', forms: ['Форма 5'] },
    { person: 'Петренко Іван Іванович', forms: ['Форма 5'] },
  ]);
});

test('a parenthetical after a name is that person\'s note, not part of the name', () => {
  const parsed = parseRequests(
    'Добрий день, потрібні ф6 на:\nІванов Іван Іванович (для пенсійного)\nПетренко Іван Іванович'
  );
  assert.deepEqual(shape(parsed.text), [
    { person: 'Іванов Іван Іванович', forms: ['Форма 6'] },
    { person: 'Петренко Іван Іванович', forms: ['Форма 6'] },
  ]);
  assert.equal(parsed.people[0].note, 'для пенсійного');
  assert.equal(parsed.people[1].note, null);
});

test('a form alone on the first line, a ranked name on the second', () => {
  assert.deepEqual(shape('Ф5\nмайор Іванов Іван Іванович'), [
    { person: 'майор Іванов Іван Іванович', forms: ['Форма 5'] },
  ]);
});

test('two forms joined by "і", name last', () => {
  assert.deepEqual(shape('Доброго ранку потрібно ф5 і ф12 на Іванов Іван Іванович'), [
    { person: 'Іванов Іван Іванович', forms: ['Форма 5', 'Форма 12'] },
  ]);
});

test('an a-stem given name written in the accusative is still recognised', () => {
  // "Миколу" is accusative, not genitive -- see nominativeCase.test.js for why
  // that is a different ending and needs its own rule.
  const parsed = parseRequests('Ф5 на Солодан Миколу Васильовича');
  assert.equal(parsed.people[0].full, 'Солодан Микола Васильович');
  assert.equal(parsed.people[0].writtenAs, 'Солодан Миколу Васильовича');
  assert.deepEqual(shape(parsed.text), [
    { person: 'Солодан Микола Васильович', forms: ['Форма 5'] },
  ]);
});

test('a form spelled out in words, with a purpose and a tab before the name', () => {
  const parsed = parseRequests(
    'Бажаю здоровя.\nПотрібна довідка форми 5 для суду на солдат\tІванов Іван Іванович'
  );
  assert.deepEqual(shape(parsed.text), [
    { person: 'солдат Іванов Іван Іванович', forms: ['Форма 5'] },
  ]);
  // The purpose has to stop before the person it was written in front of.
  assert.equal(parsed.purpose, 'суду');
});

test('two forms joined by "та"', () => {
  assert.deepEqual(shape('Потрібна ф5 та ф6 на Іванов Іван Іванович'), [
    { person: 'Іванов Іван Іванович', forms: ['Форма 5', 'Форма 6'] },
  ]);
});

test('"і" separates two requests on one line just as a comma does', () => {
  // Real traffic: no comma or semicolon at all, just the conjunction --
  // joining by line alone used to hand both people both forms.
  assert.deepEqual(
    shape('Добрий день потрібна ф6 на Борсук Андрія Андрійовича і ф5 на Колесника Віталія Васильовича'),
    [
      { person: 'Борсук Андрій Андрійович', forms: ['Форма 6'] },
      { person: 'Колесник Віталій Васильович', forms: ['Форма 5'] },
    ]
  );
});

// --------------------------------------------------------------------------
// Nothing is a request until it names both a person and a form.
// --------------------------------------------------------------------------

test('ordinary group chatter parses as no request at all', () => {
  for (const chatter of [
    'Добрий день! Хтось знає коли буде обід?',
    'Слава Україні!',
    'Дякую, все отримав',
    'Доброго ранку колеги',
  ]) {
    const parsed = parseRequests(chatter);
    assert.equal(parsed.ok, false, chatter);
    assert.deepEqual(parsed.people, [], chatter);
  }
});

test('a form with nobody to issue it to is not a request', () => {
  const parsed = parseRequests('ф5');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.forms.length, 1);
  assert.ok(parsed.warnings.some((warning) => warning.includes('no person')));
});

test('a name with no form is not a request, and says so', () => {
  const parsed = parseRequests('Іванов Іван Іванович');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.people.length, 1);
  assert.ok(parsed.warnings.some((warning) => warning.includes('Іванов Іван Іванович')));
});

test('a bare number is never read as a form', () => {
  // "ф5 і 2 людини" is one certificate, not also a "Форма 2".
  assert.deepEqual(
    findForms('потрібно ф5 і 2 людини на 15 число').map((form) => form.label),
    ['Форма 5']
  );
});

// --------------------------------------------------------------------------
// Form spellings and name shapes.
// --------------------------------------------------------------------------

test('the many ways a numbered form gets written all normalize to one label', () => {
  for (const written of ['ф5', 'Ф5', 'ф 5', 'ф-5', 'ф.5', 'ф№5', 'форма 5', 'форми 5', 'довідка ф5', 'ф05']) {
    assert.deepEqual(
      findForms(written).map((form) => form.label),
      ['Форма 5'],
      written
    );
  }
});

test('a form is only a form when the number carries its prefix', () => {
  assert.deepEqual(findForms('проф5 і шеф5').map((f) => f.label), []);
});

test('the same form asked for twice is one form for that person', () => {
  assert.deepEqual(shape('потрібна ф5, ще раз ф5 на Іванов Іван Іванович'), [
    { person: 'Іванов Іван Іванович', forms: ['Форма 5'] },
  ]);
});

test('the named form is recognised however much of it is written', () => {
  const spellings = [
    'Довідка в/с (замість ВК)', 'довідка замість ВК', 'замість вк',
    // The name OpenProject itself uses, which is what every spelling files as.
    'Довідка щодо військовослужбовця', 'потрібна довідку щодо в/с',
  ];
  for (const written of spellings) {
    assert.deepEqual(
      findForms(written).map((form) => form.label),
      ['Довідка щодо військовослужбовця'],
      written
    );
  }
});

test('two names on one line are two people', () => {
  assert.deepEqual(shape('ф5 на Іванов Іван Іванович, Петренко Петро Петрович'), [
    { person: 'Іванов Іван Іванович', forms: ['Форма 5'] },
    { person: 'Петренко Петро Петрович', forms: ['Форма 5'] },
  ]);
});

test('a rank is read off the name, including the two-word ones', () => {
  const ranks = parseRequests(
    'ф5 на:\nстарший сержант Іванов Іван Іванович\nмол. лейтенант Петренко Петро Петрович'
  );
  assert.deepEqual(
    ranks.people.map((person) => person.rank),
    ['старший сержант', 'молодший лейтенант']
  );
});

test('a name is split into its parts', () => {
  const [person] = parseRequests('ф5 на майор Іванов Іван Іванович').people;
  assert.deepEqual(
    { surname: person.surname, given: person.given, patronymic: person.patronymic, rank: person.rank },
    { surname: 'Іванов', given: 'Іван', patronymic: 'Іванович', rank: 'майор' }
  );
});

test('an all-caps surname is still recognised as part of the name, and title-cased', () => {
  const [person] = parseRequests(
    'Добрий день, потрібна довідка ф6 на старшого солдата РУСАВСЬКИЙ Миколу Васильовича'
  ).people;
  assert.deepEqual(
    { surname: person.surname, given: person.given, patronymic: person.patronymic },
    { surname: 'Русавський', given: 'Микола', patronymic: 'Васильович' }
  );
  assert.equal(person.writtenAs, 'РУСАВСЬКИЙ Миколу Васильовича');
  assert.equal(describeRequests(parseRequests(
    'Добрий день, потрібна довідка ф6 на старшого солдата РУСАВСЬКИЙ Миколу Васильовича'
  )), 'старший солдат Русавський Микола Васильович — Форма 6');
});

test('a person named with their own form keeps it instead of the header form', () => {
  assert.deepEqual(
    shape('Потрібні ф6 на:\nІванов Іван Іванович ф12\nПетренко Петро Петрович'),
    [
      { person: 'Іванов Іван Іванович', forms: ['Форма 12'] },
      { person: 'Петренко Петро Петрович', forms: ['Форма 6'] },
    ]
  );
});

// --------------------------------------------------------------------------
// The flattened view the ticket fan-out runs on.
// --------------------------------------------------------------------------

test('pairs flatten to one entry per certificate to produce', () => {
  const parsed = parseRequests('ф5 та ф12 на:\nІванов Іван Іванович\nПетренко Петро Петрович');
  assert.deepEqual(
    parsed.pairs.map((pair) => `${pair.person.surname}/${pair.form.code}`),
    ['Іванов/f5', 'Іванов/f12', 'Петренко/f5', 'Петренко/f12']
  );
});

test('the summary reads back as one line per person', () => {
  const parsed = parseRequests('І ще ф5 на:\nІванов Іван Іванович\nПетренко Петро Петрович');
  assert.equal(
    describeRequests(parsed),
    'Іванов Іван Іванович — Форма 5\nПетренко Петро Петрович — Форма 5'
  );
});

// --------------------------------------------------------------------------
// Two requests on one line. Joining by line alone gave everyone every form.
// --------------------------------------------------------------------------

test('a semicolon separates two requests written on one line', () => {
  const parsed = parseRequests(
    'Потрібна довідка ф12 на Костиря Сергій Олександрович; і ф6 для пенсійного на Жепяк Назар Васильович'
  );
  assert.deepEqual(shape(parsed.text), [
    { person: 'Костиря Сергій Олександрович', forms: ['Форма 12'] },
    { person: 'Жепяк Назар Васильович', forms: ['Форма 6'] },
  ]);
  // The purpose was written in the second clause, so it belongs to that
  // person alone -- not to everyone the message happens to name.
  assert.equal(parsed.people[0].purpose, null);
  assert.equal(parsed.people[1].purpose, 'пенсійного');
});

test('a comma separates two requests just as well', () => {
  assert.deepEqual(shape('ф12 на Костиря Сергій Олександрович, ф6 на Жепяк Назар Васильович'), [
    { person: 'Костиря Сергій Олександрович', forms: ['Форма 12'] },
    { person: 'Жепяк Назар Васильович', forms: ['Форма 6'] },
  ]);
});

test('a sentence end separates two requests', () => {
  assert.deepEqual(
    shape('Потрібна ф5 на Костиря Сергій Олександрович. Потрібна ф6 на Жепяк Назар Васильович'),
    [
      { person: 'Костиря Сергій Олександрович', forms: ['Форма 5'] },
      { person: 'Жепяк Назар Васильович', forms: ['Форма 6'] },
    ]
  );
});

test('a comma listing two forms for one person is not a second request', () => {
  assert.deepEqual(
    shape('потрібні ф5, ф12 на Костиря Сергій Олександрович; ф6 на Жепяк Назар Васильович'),
    [
      { person: 'Костиря Сергій Олександрович', forms: ['Форма 5', 'Форма 12'] },
      { person: 'Жепяк Назар Васильович', forms: ['Форма 6'] },
    ]
  );
});

test('a trailing form list stays with the person it was written after', () => {
  // Nothing follows the ф5 inside its own clause, so it falls back to the
  // person before it rather than being carried across the semicolon.
  assert.deepEqual(
    shape('Костиря Сергій Олександрович потрібно ф12, ф5; Жепяк Назар Васильович потрібно ф6'),
    [
      { person: 'Костиря Сергій Олександрович', forms: ['Форма 12', 'Форма 5'] },
      { person: 'Жепяк Назар Васильович', forms: ['Форма 6'] },
    ]
  );
});

test('one purpose in a message that names one person still applies to them', () => {
  // The purpose sits in its own clause here, so only the "nobody claimed it"
  // fallback can attach it.
  const parsed = parseRequests(
    'молодший сержант Іванов Іван Іванович потрібно довідка ф12, довідка ф5 для вихідного контролю.'
  );
  assert.equal(parsed.people[0].purpose, 'вихідного контролю');
});

test('the summary reads back why, when the message said why', () => {
  const parsed = parseRequests('ф6 для пенсійного на Жепяк Назар Васильович');
  assert.equal(describeRequests(parsed), 'Жепяк Назар Васильович — Форма 6 (пенсійного)');
});

// --------------------------------------------------------------------------
// A ticket wants the nominative; the sentence the request was written in did
// not necessarily use it.
// --------------------------------------------------------------------------

test('a declined name is filed in the nominative, with the original kept', () => {
  const parsed = parseRequests('Потрібна довідка ф5 для Іванова Івана Івановича');
  assert.deepEqual(shape(parsed.text), [
    { person: 'Іванов Іван Іванович', forms: ['Форма 5'] },
  ]);
  assert.equal(parsed.people[0].writtenAs, 'Іванова Івана Івановича');
  assert.equal(parsed.people[0].grammaticalCase, 'gen');
});

test('a rank declines with the name it introduces', () => {
  const parsed = parseRequests('ф12 для молодшого сержанта Мельника Ігоря Богдановича');
  assert.deepEqual(shape(parsed.text), [
    { person: 'молодший сержант Мельник Ігор Богданович', forms: ['Форма 12'] },
  ]);
});

test('a name already in the nominative is filed exactly as written', () => {
  const parsed = parseRequests('ф12 на Костиря Сергій Олександрович');
  assert.equal(parsed.people[0].full, 'Костиря Сергій Олександрович');
  assert.equal(parsed.people[0].grammaticalCase, 'nom');
});
