"""Run the actual v4 callback handoff: bounded copy, FIFO and reconnect fencing."""
import pathlib,shutil,subprocess,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[2]
class MultiActorInboundQueueTests(unittest.TestCase):
 def test_actual_queue(self):
  source=(ROOT/'firmware/components/agent_transport/agent_transport.c').read_text()
  queue=source[source.index('static void agent_handle_frame('):source.index('static void agent_reset_rx(')]
  prefix=r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#define AGENT_INBOUND_CAPACITY 8U
#define AGENT_TRANSPORT_MAX_JSON_FRAME_BYTES 16384U
#define taskENTER_CRITICAL(x) ((void)(x))
#define taskEXIT_CRITICAL(x) ((void)(x))
typedef struct { char *frame; size_t length; uint32_t session_counter; } agent_inbound_frame_t;
static struct { int lock; bool reconnect_requested; uint32_t session_counter; agent_inbound_frame_t inbound[8]; size_t inbound_head,inbound_count; } s_agent;
static int applied,reconnects;static bool connected=true;static char received[16];
static bool agent_uses_multi_actor_runtime(void){return true;}
static bool agent_connected(void){return connected;}
static void agent_request_reconnect(void){reconnects++;s_agent.reconnect_requested=true;}
static void agent_apply_frame(const char *p,size_t n){assert(n==1);received[applied++]=*p;}
'''
  main=r'''
int main(void){
 char frame='a';agent_handle_frame(&frame,1);frame='x';assert(applied==0);
 agent_handle_frame("b",1);agent_drain_inbound(true);assert(applied==2&&received[0]=='a'&&received[1]=='b');
 agent_handle_frame("c",1);s_agent.session_counter++;agent_drain_inbound(true);assert(applied==2);
 for(int i=0;i<8;i++)agent_handle_frame("d",1);assert(s_agent.inbound_count==8);
 agent_handle_frame("e",1);assert(reconnects==1&&s_agent.inbound_count==8);agent_drain_inbound(false);assert(s_agent.inbound_count==0&&applied==2);
 s_agent.reconnect_requested=false;agent_handle_frame("f",1);connected=false;agent_drain_inbound(true);assert(applied==2);
 connected=true;agent_handle_frame("g",1);agent_drain_inbound(true);assert(applied==3&&received[2]=='g');return 0;
}
'''
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);(p/'test.c').write_text(prefix+queue+main)
   subprocess.run([shutil.which('cc'),'-std=c11','-Wall','-Wextra','-Werror',str(p/'test.c'),'-o',str(p/'test')],check=True)
   subprocess.run([str(p/'test')],check=True)
