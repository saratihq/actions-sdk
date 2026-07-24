export {
  listUsers,
  userIdProp,
  userOptions,
  ZOOM_API_BASE,
  type ZoomMeeting,
  type ZoomMeetingListEntry,
  type ZoomUser,
  zoomAuth,
} from './common';
export {
  CREATE_MEETING_TYPE,
  createMeeting,
  DELETE_MEETING_TYPE,
  deleteMeeting,
  GET_MEETING_TYPE,
  getMeeting,
  LIST_MEETINGS_TYPE,
  listMeetings,
  UPDATE_MEETING_TYPE,
  updateMeeting,
  type ZoomMeetingMutationResult,
} from './meetings';

export { ZOOM_NEW_RECORDING_TYPE, newRecording, type ZoomRecordingEvent } from './new-recording.polling';

import { createMeeting, deleteMeeting, getMeeting, listMeetings, updateMeeting } from './meetings';

/** Every Zoom action, for catalog builds and registration. */
export const zoomActions = [createMeeting, listMeetings, getMeeting, updateMeeting, deleteMeeting] as const;
