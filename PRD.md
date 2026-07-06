# AGENT ALETHEIA

Aletheia is an agent who's job is to explore a knowledge-base (set of documents) and answer questions in a way that is
Verifiable.

Verifiability is defined by:

- Every response is an aggregation of one or more insights, each insight is grounded in a specific part of the
  knowledge-base and has a hard reference to the knowledge-base
- User can easily verify the source(s) of the knowledge that created the response

Aletheia will also strive to have good Precision (correct answers) and Recall (complete answers) but where it shines is
through Verifiability.

# USER WORKFLOW

- User stores documents in the /knowledge-base folder (assume each doc is a JSON, it has a "body" and it has a "
  metadata". Metadata is used to filter without retreiving the bodies, the bodies are retreived by sub-agents)
- User asks a question
- User gets a response
- User can expand the response and drill-down into individual signals each showing a rich set of information about the
  signal (details shown in the data model bellow)

# DATA MODEL FOR THE RESPONSE

```
{
  "question": The question user typed,
  "response": {
     "scope_of_exploration": A list of all documents IDs that were included in the search
     "cost_estimate": The $ estimate for the token cost of generating this response
     "delay": How long it took to generate this response
     "response_text": The high-level aggregated answer to the question (human readable and directly answering their question)
     "response_reasoning": The plain english resoning for how the aggregation was done
     "filtering_reasoning": If any signal was filtered out, the reasoning behind it
     "signals": [
        {
           "signal_type: signal (either "signal" or "no-signal")
           "scope_of_signal": The ID of the knowledgebase doc that is the scope for this signal
           "question_rescoped": The user question that is rescoped (rephrased) to be about one document only
           "payload_format": The strongly typed format for the signal's payload - this varies for every question and this is the format that the orchestrator expects to get the signal reported back
           "id": ID for the signal
           "reference_text": The complete quote snippet from the doc above that contained the signal
           "before_reference_text": One or two sentences immediately before the reference_text
           "after_reference_text": One or two sentences immediately after the reference_text
           "ref_fuzzy_distance": The fuzzball (fuzzy matching) score (0-100) of how closely the reference matches a part of the source document
           "confidence": the models confidence score in this response
           "cost_estimate": cost estimate for this individual signal
           "model": model used to generate this signal
           "accuracy_pass": whether the signal passed the accuracy test
        }
     ]
}
```

```
signal for type no-signal =
{
   "signal_type: no-signal (either "signal" or "no-signal")
   "scope_of_signal": The ID of the knowledgebase doc that is the scope for this signal
   "question_rescoped": The user question that is rescoped (rephrased) to be about one document only
   "payload_format": The strongly typed format for the signal's payload - this varies for every question and this is the format that the orchestrator expects to get the signal reported back
   "id": ID for the signal
   "model": model used to generate this signal
}
```

# FORMATTING FOR CLI/UI
QUESTION: ...

<n> documents were considered relevant and were examined (>expand will list them)

ANSWER: ...

Answer was based on a total of <n> signals

Signal expandable card (when contracted, only show payload and quote)
  - document name (scope_of_signal)
  - re-scoped question
  - signal confidence (condifence)
  - accuracy_pass (was this signal accurate?)
  - payload (payload_format varies)
  - Quote
    - ref_fuzzy_distance (how closely this matches the document verbatim)
    - before_reference_text (greyed)
    - reference_text (highlighted)
    - after_reference_text (grayed)
  - Stats
    - model
    - cost_estimate


# ARCHITECTURE

## ORCHESTRATOR

The orchestrator agentic loop does these things in order

1. *Filter* the knowledge-base documents and find a narrow and appropriate `scope_of_exploration`
    * To do this orchestrator will examine the metadata structure for the documents
    * Will create a query based on the users question
    * OUTPUT: A list of document IDs that are the `scope_of_exploration`, there are all the documents that will be read
      in detail
2. *Re-phrase* the question into `question_rescoped` to be about one document only (eg.
   `question = has any customer talked about price in the last week?` ->
   `question_rescoped = Did the customer talk about product price in this meeting?`)
3. *Compose the `payload_format`* which is the strongly typed and question-specific part of the format for the signal
   expected from each sub-agent back to the orchestrator (there are also a few default parts of the payload returned
   with every signal as shown in the data model before)
4. *Spawn one sub-agent per document* in the `scope_of_exploration` and pass the relevant infomation
    * `scope_of_signal`
    * `question_rescoped`
    * `payload_format`
    * `model`
5. *Wait and accumulate signals* from sub-agents
    * A sub-agent may emit more than one signal, in that case they will send the signals in a list and emit once
    * A sub-agent may send a special signal type `no-signal` format indicating that they looked and did not find any
      signal
    * LOGIC of signal accumulation
        * If a sub-agent has sent signal(s) back they are done
        * If a sub-agent has sent a no-signal back they are done
        * If all sub-agents are done -> move forward to aggregating signals into a response
        * If the signal is NOT in the format expected (log and error and surface in debug-mode) move-on
        * If you have waited more than 2 minutes and >90% of sub-agents have already responded, expose what sub-agents
          had not responded yet and move on to aggregation
        * If you have waited more than 5 minutes, time-out, expose what sub-agents had not responded yet and move on to
          aggregation
6. *Filter signals* based on some pre-defined thresholds that are stored in a global file. Here are some presets
    * `accuracy_pass_enforced = TRUE` means the signals that failed the accuracy test will be excluded
    * `ref_fuzzy_distance_cutoff = 80` the references with fuzzball score of less than 80 are too hallucinated to be
      reliable and verifiable and are therefore filtered out
7. *Aggregate signals* and compose the final response. This response needs to be directly answering the user's question

## PER-DOC SUB-AGENT

1. Receive the full instructions from the orchestrator
2. Retrieve ONLY the document in `scope_of_signal` (it is IMPORTANT that the sub-agent loads ONLY this one document into
   it's context and nothing else)
3. Generate one or more signals -> Test each for fuzzball score and accuracy score -> Send a list of signals back to the
   orchestrator in one communication
4. OR generate a "no-signal" type of event to indicate there was no such signal in this document

# Open questions

* How does the sub-agent know it is done after having generated one signal? How does it know if it has generated one
  signal but working on generating more?
* If the documents are stored as individual JSON docs with "metadata" and "body", how can we have the orchestrator JUST
  look at the "metadata" without loading the bodies into context unnecessarily? And how can we have each sub-agent
  retrieve ONLY a single body without loading other bodies unnecessarily?