// ---------- Play 데이터 안전 — CSV 왕복 (ROADMAP #4) ----------
// 구글이 콘솔에서 Export/Import CSV를 공식 제공한다(2026-07-29 발견). 그래서 이 설문만은
// DOM을 긁지 않는다 — 기계 판독 ID가 그대로 들어 있어 콘솔 개편에 면역이고, 쓰기도 파일 하나면 된다.
//
// 실측 형태(782행): 컬럼 5개
//   Question ID (machine readable) | Response ID (machine readable) | Response value
//   | Answer requirement | Human-friendly question label
// 행 규칙:
//   - Response ID가 비면 그 행이 곧 질문이다 (Response value에 답이 들어온다: true/false/문자열)
//   - Response ID가 있으면 선택지 행이다 (Response value가 차 있으면 그 선택지가 선택됨)
//   - 라벨은 "질문 / 선택지" 형태로 합쳐져 오므로 마지막 ' / '로 가른다
// 고유 질문 217개 / 선택지 행 782개.

import type { DataSafetyDoc, DsQuestion } from '../shared/console-types'
export type { DataSafetyDoc, DsQuestion, DsOption } from '../shared/console-types'

// RFC4180 최소 파서 — 따옴표 안의 쉼표·줄바꿈·이중따옴표를 처리한다.
// 라벨에 쉼표가 흔해서(예: "Username, password, and other authentication") split(',')는 못 쓴다.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const src = text.replace(/^﻿/, '') // BOM 제거
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
      continue
    }
    if (c === '"') inQuotes = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      field = ''
      // 빈 줄은 버린다
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// "질문 / 선택지" → 선택지 부분만. ' / '가 없으면 원문 그대로.
const optionLabel = (full: string): string => {
  const i = full.lastIndexOf(' / ')
  return i >= 0 ? full.slice(i + 3) : full
}
const questionLabel = (full: string): string => {
  const i = full.lastIndexOf(' / ')
  return i >= 0 ? full.slice(0, i) : full
}

export function parseDataSafetyCsv(text: string): DataSafetyDoc {
  const rows = parseCsv(text)
  if (rows.length < 2) return { at: new Date().toISOString(), rows: 0, questions: [], answeredCount: 0 }
  const header = rows[0].map((h) => h.trim())
  const col = (name: string): number => header.findIndex((h) => h.startsWith(name))
  const iQ = col('Question ID')
  const iR = col('Response ID')
  const iV = col('Response value')
  const iReq = col('Answer requirement')
  const iLabel = col('Human-friendly question label')
  if (iQ < 0 || iV < 0) throw new Error('unexpected-csv-header')

  const byId = new Map<string, DsQuestion>()
  const order: string[] = []
  for (const r of rows.slice(1)) {
    const qid = (r[iQ] ?? '').trim()
    if (!qid) continue
    const rid = (r[iR] ?? '').trim()
    const value = (r[iV] ?? '').trim()
    const req = (r[iReq] ?? '').trim()
    const full = (r[iLabel] ?? '').trim()

    let q = byId.get(qid)
    if (!q) {
      q = { id: qid, label: questionLabel(full), requirement: req, value: '', options: [], answered: false }
      byId.set(qid, q)
      order.push(qid)
    }
    // 선택지 행이 오면 질문 라벨을 '앞부분'으로 다듬는다(질문 행만 있을 땐 전체가 곧 질문).
    if (rid && questionLabel(full)) q.label = questionLabel(full)
    if (rid) {
      q.options.push({ responseId: rid, label: optionLabel(full), selected: !!value })
      if (value) q.answered = true
    } else if (value) {
      q.value = value
      q.answered = true
    }
  }
  const questions = order.map((id) => byId.get(id) as DsQuestion)
  return {
    at: new Date().toISOString(),
    rows: rows.length - 1,
    questions,
    answeredCount: questions.filter((q) => q.answered).length
  }
}
