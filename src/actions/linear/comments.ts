import { defineAction } from '../../core/action';
import { longText, shortText } from '../../core/props';
import { linearAuth, linearGraphql } from './common';

/** Public type — a stable public catalog id. */
export const CREATE_COMMENT_TYPE = 'linear.create_comment';

/** A Linear comment, trimmed to the fields workflows read. */
export interface LinearComment {
  id: string;
  body: string;
  url: string;
  createdAt?: string;
}

const CREATE_COMMENT_MUTATION = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id body url createdAt } }
}`;

/** Add a comment to an issue. Markdown body. */
export const createComment = defineAction({
  type: CREATE_COMMENT_TYPE,
  name: 'Create comment',
  description: 'Add a comment to a Linear issue.',
  auth: linearAuth,
  props: {
    issueId: shortText<true>({ label: 'Issue id', required: true }),
    body: longText<true>({ label: 'Comment', description: 'Markdown supported.', required: true }),
  },
  async run({ auth, props, http }): Promise<{ success: boolean; comment: LinearComment }> {
    const data = await linearGraphql<{ commentCreate: { success: boolean; comment: LinearComment } }>(
      http,
      auth,
      CREATE_COMMENT_MUTATION,
      { input: { issueId: props.issueId, body: props.body } },
    );
    return { success: data.commentCreate.success, comment: data.commentCreate.comment };
  },
});
