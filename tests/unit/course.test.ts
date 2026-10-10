// tests/unit/course.test.ts — ring detection, including the case that will
// break first.

import { describe, expect, it } from 'vitest'
import { HOVERJET } from '@/generated/constants.generated'
import { FIXED_DT } from '@/sim/constants'
import { createCourse, type Gate, stepCourse, stepDistance } from '@/sim/course'
import { v3 } from '@/sim/math/vec3'
import int01 from '../../content/levels/int_01_hoverJet.json'

const gate = (x: number, radius = 10, points = 100): Gate => ({
  centre: v3(x, 0, 0),
  radius,
  points,
  triggerOnce: true,
})

describe('ring detection', () => {
  it('scores a gate once and never again', () => {
    const course = createCourse([gate(0)])
    expect(stepCourse(course, v3(0, 0, 0))).toBe(0)
    expect(course.score).toBe(100)
    // Still inside it on the next step, and every step after.
    expect(stepCourse(course, v3(1, 0, 0))).toBe(-1)
    expect(stepCourse(course, v3(0, 0, 0))).toBe(-1)
    expect(course.score).toBe(100)
    expect(course.passedCount).toBe(1)
  })

  it('ignores a near miss just outside the radius', () => {
    const course = createCourse([gate(0, 10)])
    expect(stepCourse(course, v3(10.01, 0, 0))).toBe(-1)
    expect(stepCourse(course, v3(9.99, 0, 0))).toBe(0)
  })

  it('scores at most one gate per step, nearest first', () => {
    // Two overlapping gates. Scoring both from one position would double-count
    // a single pass, which is how a 21-ring course reports 22.
    const course = createCourse([gate(0, 30), gate(10, 30)])
    const first = stepCourse(course, v3(9, 0, 0))
    expect(first).toBe(1)
    expect(course.score).toBe(100)
    // The other one still scores later, on its own step.
    expect(stepCourse(course, v3(0, 0, 0))).toBe(0)
    expect(course.score).toBe(200)
  })

  it('respects triggerOnce: false — once per ENTRY, not once per tick inside', () => {
    // `TriggerCheckpoint` has an `OnTriggerEnter` and no `OnTriggerStay`, so a
    // ring that does not deactivate itself pays again when you fly through it
    // AGAIN. It used to pay on every tick the ship was inside it, which made
    // its score a function of the frame rate. Nothing 2016 ships sets this
    // flag, so the change is unobservable in play — but the rule is the one
    // DEV-149 is about, written where it can be seen.
    const course = createCourse([{ ...gate(0), triggerOnce: false }])
    expect(stepCourse(course, v3(20, 0, 0))).toBe(-1)
    expect(stepCourse(course, v3(0, 0, 0))).toBe(0)
    // Lingering pays nothing.
    expect(stepCourse(course, v3(0, 0, 0))).toBe(-1)
    expect(course.score).toBe(100)
    // Out, and back through: it pays again.
    expect(stepCourse(course, v3(20, 0, 0))).toBe(-1)
    expect(stepCourse(course, v3(0, 0, 0))).toBe(0)
    expect(course.score).toBe(200)
  })
})

describe('the gates are big enough for the speed the ship reaches', () => {
  it('cannot tunnel through int_01 at full boost', () => {
    // A point test misses a sphere entirely if the ship crosses it inside one
    // step. This is the assertion that turns that from an assumption into a
    // measurement — and it is close enough to matter: a smaller gate or a
    // faster vehicle in a later mission fails here rather than in play, where
    // it would look like a detection bug rather than a stepping one.
    const topSpeed = HOVERJET.ship.maxSpeed * HOVERJET.ship.boostMultiplier
    const perStep = stepDistance(topSpeed, FIXED_DT)

    const radii = (int01.routes[0]?.rings ?? []).map((r) => r.trigger.radius)
    expect(radii.length).toBe(21)
    const smallest = Math.min(...radii)

    // The sphere's DIAMETER has to exceed the step, or the ship can pass clean
    // through between two samples.
    expect(smallest * 2).toBeGreaterThan(perStep)
    // And by a real margin, not by a hair.
    expect((smallest * 2) / perStep).toBeGreaterThan(1.5)
  })
})
