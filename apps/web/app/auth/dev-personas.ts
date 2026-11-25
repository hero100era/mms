export interface DevPersona {
  key: string
  userId: string
  name: string
  email: string
  kind: 'internal' | 'external'
  role: string
  category: string
  scope: string
  notes?: string
}

export const DEV_PERSONAS: DevPersona[] = [
  {
    key: 'customer.a',
    userId: '00000000-0000-4000-8000-000000000101',
    name: 'External Customer A',
    email: 'customer.a@test.mms.local',
    kind: 'external',
    role: 'ext_user',
    category: 'Customer',
    scope: 'TEST ABC SHIPPING LTD (Ships: ALPHA, BRAVO)',
    notes: 'Isolated from Customer B ships and survey requests',
  },
  {
    key: 'customer.b',
    userId: '00000000-0000-4000-8000-000000000102',
    name: 'External Customer B',
    email: 'customer.b@test.mms.local',
    kind: 'external',
    role: 'ext_user',
    category: 'Customer',
    scope: 'TEST XYZ MARITIME LTD (Ship: CHARLIE)',
    notes: 'Isolated from Customer A ships and survey requests',
  },
  {
    key: 'surveyor.shanghai',
    userId: '00000000-0000-4000-8000-000000000103',
    name: 'Shanghai Surveyor',
    email: 'surveyor.shanghai@test.mms.local',
    kind: 'internal',
    role: 'int_surveyor',
    category: 'Survey & Operations',
    scope: 'Shanghai Station (SHA)',
    notes: 'Active qualification TEST_GENERAL_SURVEY',
  },
  {
    key: 'auditor.shanghai',
    userId: '00000000-0000-4000-8000-000000000104',
    name: 'Shanghai Auditor',
    email: 'auditor.shanghai@test.mms.local',
    kind: 'internal',
    role: 'int_auditor',
    category: 'Survey & Operations',
    scope: 'Shanghai Station (SHA)',
    notes: 'Auditor inspection role',
  },
  {
    key: 'manager.shanghai',
    userId: '00000000-0000-4000-8000-000000000105',
    name: 'Shanghai Station Manager',
    email: 'manager.shanghai@test.mms.local',
    kind: 'internal',
    role: 'int_manager',
    category: 'Survey & Operations',
    scope: 'Shanghai Station (SHA)',
    notes: 'Station triage, dispatch and local management',
  },
  {
    key: 'surveyor.singapore',
    userId: '00000000-0000-4000-8000-000000000106',
    name: 'Singapore Surveyor',
    email: 'surveyor.singapore@test.mms.local',
    kind: 'internal',
    role: 'int_surveyor',
    category: 'Survey & Operations',
    scope: 'Singapore Station (SIN)',
    notes: 'Active qualification TEST_SPECIAL_SURVEY, isolated from SHA requests',
  },
  {
    key: 'coordinator.asia',
    userId: '00000000-0000-4000-8000-000000000107',
    name: 'Asia Coordinator',
    email: 'coordinator.asia@test.mms.local',
    kind: 'internal',
    role: 'int_coordinator',
    category: 'Regional Office',
    scope: 'Asia Regional Office (ASIA-RO)',
    notes: 'Regional coordination across stations in Asia region',
  },
  {
    key: 'mts.asia',
    userId: '00000000-0000-4000-8000-000000000108',
    name: 'Asia MTS Specialist',
    email: 'mts.asia@test.mms.local',
    kind: 'internal',
    role: 'int_surveyor',
    category: 'Specialized Centres',
    scope: 'Asia MTS Centre (MTS-ASIA)',
    notes: 'Coverage over Asia RO vessels; isolated from non-covered units',
  },
  {
    key: 'planapproval.central',
    userId: '00000000-0000-4000-8000-000000000109',
    name: 'Plan Approval Centre Engineer',
    email: 'planapproval.central@test.mms.local',
    kind: 'internal',
    role: 'int_surveyor',
    category: 'Specialized Centres',
    scope: 'Central Plan Approval Centre (PA-CENTRAL)',
    notes: 'Centralized engineering plan approval scope',
  },
  {
    key: 'compliance.ho',
    userId: '00000000-0000-4000-8000-000000000110',
    name: 'HO Compliance Officer',
    email: 'compliance.ho@test.mms.local',
    kind: 'internal',
    role: 'int_compliance',
    category: 'Global Oversight',
    scope: 'HO Compliance (HO-COMP, Global)',
    notes: 'Global read/audit oversight; no implicit business approval',
  },
  {
    key: 'hr.test',
    userId: '00000000-0000-4000-8000-000000000111',
    name: 'Test HR Officer',
    email: 'hr.test@test.mms.local',
    kind: 'internal',
    role: 'int_hr',
    category: 'Global Support & Administration',
    scope: 'HO Human Resources (HO-HR, Global)',
    notes: 'Staff directory and role assignment admin; no survey approval authority',
  },
  {
    key: 'finance.test',
    userId: '00000000-0000-4000-8000-000000000112',
    name: 'Test Finance Officer',
    email: 'finance.test@test.mms.local',
    kind: 'internal',
    role: 'int_finance',
    category: 'Global Support & Administration',
    scope: 'HO Finance (HO-FIN, Global)',
    notes: 'Financial oversight; segregation of duties from survey ops',
  },
  {
    key: 'sysadmin.test',
    userId: '00000000-0000-4000-8000-000000000113',
    name: 'Test Sysadmin',
    email: 'sysadmin.test@test.mms.local',
    kind: 'internal',
    role: 'int_sysadmin',
    category: 'Global Support & Administration',
    scope: 'HO Information Technology (HO-IT, Global)',
    notes: 'Platform admin only; strict Segregation of Duties: NO business survey approvals',
  },
  {
    key: 'surveyor.expired',
    userId: '00000000-0000-4000-8000-000000000114',
    name: 'Expired Qualification Surveyor',
    email: 'surveyor.expired@test.mms.local',
    kind: 'internal',
    role: 'int_surveyor',
    category: 'Adversarial Edge Cases',
    scope: 'Shanghai Station (SHA)',
    notes: 'Holds TEST_GENERAL_SURVEY with expired validity date (must be refused)',
  },
  {
    key: 'breakglass.test',
    userId: '00000000-0000-4000-8000-000000000115',
    name: 'Test Break Glass',
    email: 'breakglass.test@test.mms.local',
    kind: 'internal',
    role: 'int_viewer',
    category: 'Emergency Access',
    scope: 'Head Office (HO)',
    notes: 'Registered break-glass account; dormant until explicit emergency activation',
  },
]

export function findDevPersona(keyOrIdOrEmail: string): DevPersona | undefined {
  let target = keyOrIdOrEmail.toLowerCase().trim()
  return DEV_PERSONAS.find(
    (p) =>
      p.key.toLowerCase() === target ||
      p.userId.toLowerCase() === target ||
      p.email.toLowerCase() === target,
  )
}
