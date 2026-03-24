---
layout: page
title: "The Codex — Technical Grimoire"
description: "Technical details of the BlockDAG protocols that power the DAGKnight realm"
---

## What is a BlockDAG?

A **Block Directed Acyclic Graph (BlockDAG)** is a generalization of the blockchain where each block can reference multiple predecessors. Instead of a single chain, the structure forms a DAG — a graph with directed edges and no cycles.

This allows:
- **Multiple blocks created per second** — miners don't compete to orphan each other
- **Higher throughput** — the network's full capacity is utilized
- **Faster confirmations** — no waiting for the next single block

## The PHANTOM Protocol

PHANTOM solves the ordering problem in BlockDAGs. Given a DAG of blocks, PHANTOM:

1. Identifies a **k-cluster** — the largest set of blocks where each block is connected to all but at most *k* others
2. Uses this cluster as the "honest" set
3. Orders blocks by giving priority to cluster members

The parameter *k* relates to the network's block creation rate and propagation delay, capturing how many parallel blocks honest nodes might create before seeing each other's work.

## The DAGKnight Protocol

DAGKnight advances PHANTOM by removing the need to set *k* in advance:

- It **observes the DAG structure** to infer network conditions in real-time
- Confirmation times **adapt automatically** — faster when the network is healthy, more cautious under attack
- It provides **provable security** without assumptions about propagation delay

## The Kaspa Implementation

[Kaspa](https://kaspa.org) is the first production implementation of a BlockDAG with PHANTOM/DAGKnight consensus:

- **1 block per second** (targeting higher with future upgrades)
- **GHOSTDAG** variant for fast ordering
- **Pruning** to manage DAG growth over time
- **Rust implementation** (rusty-kaspa) for performance

---

*Explore the full technical documentation at [vProgs.xyz](https://vprogs.xyz) or [BlockDAG.xyz](https://blockdag.xyz).*
