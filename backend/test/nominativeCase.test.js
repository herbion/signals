import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toNominative, detectCase, looksLikePatronymic } from '../src/signal/nominativeCase.js';

const name = (surname, given, patronymic) => {
  const out = toNominative({ surname, given, patronymic });
  return [out.surname, out.given, out.patronymic].join(' ');
};

test('a name already in the nominative is returned untouched', () => {
  const out = toNominative({ surname: 'Костиря', given: 'Сергій', patronymic: 'Олександрович' });
  assert.equal(out.converted, false);
  assert.equal(out.case, 'nom');
  assert.equal(name('Костиря', 'Сергій', 'Олександрович'), 'Костиря Сергій Олександрович');
});

test('genitive and accusative — "довідка для Іванова Івана Івановича"', () => {
  assert.equal(name('Іванова', 'Івана', 'Івановича'), 'Іванов Іван Іванович');
  assert.equal(name('Петренка', 'Петра', 'Петровича'), 'Петренко Петро Петрович');
  assert.equal(name('Мельника', 'Ігоря', 'Богдановича'), 'Мельник Ігор Богданович');
  assert.equal(name('Ковальчука', 'Василя', 'Миколайовича'), 'Ковальчук Василь Миколайович');
  assert.equal(name('Ковальського', 'Андрія', 'Сергійовича'), 'Ковальський Андрій Сергійович');
});

test('dative — "видати Ковальчуку Василю Миколайовичу"', () => {
  assert.equal(name('Ковальчуку', 'Василю', 'Миколайовичу'), 'Ковальчук Василь Миколайович');
  assert.equal(name('Іванову', 'Івану', 'Івановичу'), 'Іванов Іван Іванович');
  assert.equal(name('Петренкові', 'Павлові', 'Павловичу'), 'Петренко Павло Павлович');
});

test('instrumental — the -им ending is two different surnames', () => {
  // Possessive keeps its stem, adjectival takes -ий back.
  assert.equal(name('Івановим', 'Іваном', 'Івановичем'), 'Іванов Іван Іванович');
  assert.equal(name('Ковальським', 'Андрієм', 'Сергійовичем'), 'Ковальський Андрій Сергійович');
  assert.equal(name('Білим', 'Петром', 'Петровичем'), 'Білий Петро Петрович');
  assert.equal(name('Петренком', 'Павлом', 'Павловичем'), 'Петренко Павло Павлович');
});

test('female names decline on their own endings', () => {
  assert.equal(name('Іванової', 'Марії', 'Іванівни'), 'Іванова Марія Іванівна');
  assert.equal(name('Іванову', 'Марію', 'Іванівну'), 'Іванова Марія Іванівна');
  assert.equal(name('Івановою', 'Марією', 'Іванівною'), 'Іванова Марія Іванівна');
  assert.equal(toNominative({ patronymic: 'Іванівна' }).converted, false);
});

test('a -ко surname is told from a consonant stem by the letter before the к', () => {
  // Петре-н-ка has a consonant there and is Петренко; Мельн-и-ка has a vowel
  // and is Мельник. Getting this wrong renames real people.
  assert.equal(name('Шевченка', 'Тараса', 'Григоровича'), 'Шевченко Тарас Григорович');
  assert.equal(name('Бойка', 'Івана', 'Івановича'), 'Бойко Іван Іванович');
  assert.equal(name('Кравчука', 'Івана', 'Івановича'), 'Кравчук Іван Іванович');
});

test('a male given name ending in -о is restored from the list, not a rule', () => {
  // "Петра" and "Івана" are the same shape; only one of them loses an о.
  assert.equal(name('Іванова', 'Петра', 'Івановича'), 'Іванов Петро Іванович');
  assert.equal(name('Іванова', 'Івана', 'Івановича'), 'Іванов Іван Іванович');
  assert.equal(name('Іванова', 'Михайла', 'Івановича'), 'Іванов Михайло Іванович');
});

test('a-stem given names have a different shape for genitive and accusative', () => {
  // Unlike "Олега" (same word for both), "Миколи"/"Миколу" are two different
  // endings and both have to come back as "Микола".
  assert.equal(name('Солодан', 'Миколу', 'Васильовича'), 'Солодан Микола Васильович');
  assert.equal(name('Солодан', 'Миколи', 'Васильовича'), 'Солодан Микола Васильович');
  assert.equal(name('Петренка', 'Іллю', 'Петровича'), 'Петренко Ілля Петрович');
  assert.equal(name('Петренка', 'Іллі', 'Петровича'), 'Петренко Ілля Петрович');
});

test('the case is read off the patronymic, gender and all', () => {
  assert.deepEqual(detectCase('Олександровича'), {
    gender: 'm',
    case: 'gen',
    nominative: 'Олександрович',
  });
  assert.equal(detectCase('Іванівною').case, 'ins');
  assert.equal(detectCase('Іванівною').gender, 'f');
  assert.equal(detectCase('Костиря'), null);
});

test('a name with no patronymic is left alone, having said nothing about its case', () => {
  const out = toNominative({ surname: 'Іванова', given: 'Марія', patronymic: null });
  assert.equal(out.converted, false);
  assert.equal(out.surname, 'Іванова');
});

test('a patronymic is recognised in every case, so the parser can anchor on it', () => {
  for (const written of ['Іванович', 'Івановича', 'Івановичу', 'Івановичем', 'Іванівна', 'Іванівни']) {
    assert.ok(looksLikePatronymic(written), written);
  }
  for (const other of ['Іванов', 'Костиря', 'Сергій', 'довідка']) {
    assert.equal(looksLikePatronymic(other), false, other);
  }
});
