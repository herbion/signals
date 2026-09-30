const regexStr = '^[/!]ticket\\\\b';
console.log('Regex string:', regexStr, 'length:', regexStr.length);
const regex = new RegExp(regexStr, 'im');
const text = '/ticket Fix navigation header\\nMore details here';
const match = text.match(regex);
console.log('Match?', match);

const regexStr2 = '^[/!]ticket\\b';
console.log('Regex string 2:', regexStr2, 'length:', regexStr2.length);
const regex2 = new RegExp(regexStr2, 'im');
const match2 = text.match(regex2);
console.log('Match 2?', match2);
