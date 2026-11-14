import type { Role } from './schemas.js'

// CCS faculty and administrative personnel, from the official CCS Faculty list. Login-only accounts: the emails are
// made-up addresses on access-ccs.com (send-only domain, no inboxes), so nothing is ever mailed to them (store.ts isSampleAddress).
type Group = 'Plantilla' | 'COS full-time' | 'COS part-time' | 'Administrative personnel'
const list = (group: Group, names: string) => names.split('; ').map(n => ({ group, n }))
const people = [
  ...list('Plantilla', 'Angela L. Arago [IS]; Redentor G. Bucaling Jr. [IT]; Paula Joy L. Dela Cruz [IS]; Christian B. Escoto [CS]; Maria Aura C. Impang [CS]; Mary Jean M. Jayobo [CS]; Geovanni P. Jomoc [IT]; Joan F. Lawan [IT]; Norilyn C. Sindanum [IT]; Dr. Isagani M. Tano [CS]'),
  ...list('COS full-time', 'Raul S. Acapulco [IS]; Emanuel C. Alarilla [IT]; Dr. Ezekiel R. Borja [IT]; Manuel Luis C. Delos Santos [CS]; Ronnie P. Gatdula [IS]; Laser Ryan V. Lleno [IS]; Manuel L. Los Añes Jr. [IT]; Harold R. Lucero [IT]; Marilou B. Mangrobang [IT]; Benjamin D. Molinar [IS]; Cyrille Anne I. Nery [IS]; Arlyn D. Orense [IT]; Rhonnel Paculanan [CS]; Zharina T. Pascual [IT]; Dr. Erwin B. Quendangan [IS]; Carlo N. Romero [IT]; Richard Morris A. Santos [CS]; Samson A. Semwenda [IS]; Adelan P. Sistoso [IT]; Rose Anne A. Tanjente [IT]; Thelma D. Villamorel [IT]'),
  ...list('COS part-time', 'Emelita M. Alonzo [IT]; Jenelyn M. Aranas [IT]; Valeree Maree A. Asuncion [IT]; Bernabe M. Cabuhayan [IT]; Teresita M. Cruz [IT]; Milardo T. De Guzman [IT]; Clemgen C. Dela Cruz [IT]; Arnel P. Distor [IS]; Melchor G. Erise [CS]; Christian U. Esguerra [IT]; Noel C. Gagolinan [IT]; Mel F. Galat [IT]; John R. Garcia [IT]; Francis P. Gubangco [IT]; John Rizz D. Herbosa [IT]; Quirra Mae D. Nadera [IT]; Mary Grace D. Nulud [IT]; John Christopher T. Papa [IT]; Miguel Jerome N. Silverio [CS]'),
  ...list('Administrative personnel', 'Melchor Acilo; Leovin Corpuz; Maricris Fernandez; Kevin Kaiser Garcia; Nadine Pimentel; Carl Joshua Quijano; John Lester Tulagan; John Daenell Nocete'),
]
const programs = { IT: 'BSIT', CS: 'BSCS', IS: 'BSIS' } as const

/** The 58 people: id, display name, made-up email, roles, program (faculty), title and list group. */
export const facultyRoster = people.map(({ group, n }) => {
  const [, raw, code] = n.match(/^(.*?)(?: \[(IT|CS|IS)\])?$/)!
  const name = raw!
  const words = name.replace(/^Dr\. /, '').replace(/ Jr\.$/, '').split(' ')
  const initial = words.map(w => /^[A-Z]\.$/.test(w)).lastIndexOf(true)
  const ascii = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const local = `${ascii(words[0]!)}.${ascii(words.slice(initial < 0 ? -1 : initial + 1).join(''))}`
  const admin = group === 'Administrative personnel'
  const secretary = name === 'Maricris Fernandez'
  const program = code ? programs[code as keyof typeof programs] : undefined
  return {
    id: `${secretary ? 'QCU-SECRETARY' : admin ? 'QCU-STAFF' : 'QCU-FAC'}-${local.toUpperCase().replace('.', '-')}`,
    name, email: `${local}@access-ccs.com`, roles: [secretary ? 'secretary' : admin ? 'staff' : 'professor'] as Role[], program,
    title: secretary ? 'CCS secretary' : admin ? group : `Faculty (${group}), ${program}`, group,
  }
})
