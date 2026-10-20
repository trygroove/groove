/**
 * The turn the assistant takes by itself once a proposal is applied (GRV-195),
 * so a producer who pressed Apply is never left with nothing to do next: the
 * assistant reacts to the change, now in the song, and suggests one next
 * step. It is an ordinary turn (it streams, it may propose, quota and spend
 * count it); only its message is the browser's, not the producer's.
 */

/**
 * What the follow-up says, as the model reads it. The reply before it carries
 * the note that the proposal was applied (`proposalNote`), and the project
 * description is the song with the change in it.
 */
export const FOLLOW_UP_MESSAGE =
  "[Applied] I applied your proposal. The project description shows the song as it is now. " +
  "In a sentence or two, react to what the change does for the song, then suggest one next step. " +
  "If we are working through steps together (a lesson, a tutorial, a plan), the next step is the next one of those. " +
  "You may propose it as a change.";

/**
 * What a card from the follow-up's turn is titled by, as a producer's own
 * message titles theirs. The log does not show the follow-up's message.
 */
export const FOLLOW_UP_TITLE = "Next step";
