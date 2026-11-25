# linux-ingress-notes

How does a packet get from the network card to `recv()`?

I follow one UDP packet. In the example, the packet's interrupt goes to core 3, and my program runs on core 5, sleeping inside `recv()`.

Some short forms first:

- **NIC**: network interface card, the network card.
- **DMA**: direct memory access. The NIC writes to RAM on its own, without the CPU copying anything.
- **IRQ**: interrupt request, a hardware interrupt.
- **skb**: `sk_buff`, socket buffer. The kernel's own struct to describe a packet.

## Preparation

### Memory allocation

When the network interface is brought up, the driver allocates memory and sets up 2 kinds of ring buffers, Tx and Rx. Tx is for sending, and Rx is for receiving. A card can have many of each.

These rings only contain descriptors, a small data type to identify the packet in memory, not the actual packet itself. The packets live in a separate place in RAM, called packet buffers or something. The driver allocates some buffers, writes the address of a buffer into each Rx descriptor, and tells the NIC where the ring is. So the NIC knows where it is allowed to write before any packet arrives.

### Handler registration

The driver also registers functions for the CPU to call upon certain events. There are two that matter here:

- **The interrupt handler.** This runs when the NIC interrupts a core. Each Rx ring can have its own interrupt, and each interrupt goes to a particular core.
- **The poll function.** This reads packets from the Rx ring. Each Rx ring has a `napi_struct`, which points to the driver's poll function.

## The flow

### 1. The NIC picks an Rx ring

When there are multiple Rx rings, the NIC distributes the load across them. It does this by hashing something like (src_ip, src_port, dest_ip, dest_port). This is called RSS, receive side scaling. When a single sender sends from one src_ip, src_port to one dest_ip, dest_port, the hash stays the same, so every packet goes to the same ring.

It does not do round-robin. With round-robin, packets of the same flow could land on different cores, and get processed out of order.

Since each ring has its own interrupt, picking a ring also picks the core.

### 2. DMA

The NIC gets the next free descriptor from the Rx ring, and writes the packet to the location in memory that the descriptor points to. This is DMA. Then it writes the length of the packet into the descriptor(thats how the driver knows which ones are ready).

### 3. The interrupt

Once the packet is in memory, the NIC interrupts the core, to tell it something like "handle incoming packet". Only that core is interrupted, the other cores keep running.

When an interrupt is running, nothing else can run on that core, so it has to be handled as quickly as possible. The handler does not touch the packet. It adds the ring's `napi_struct` to the core's poll list, and marks that there is work to do. Each core has its own poll list. An entry in it means "this Rx ring needs polling".

### 4. Polling, with the interrupt off

If every packet raised an interrupt, the system as a whole would be very slow. So the goal is to minimize the interrupts raised.

When the first packet arrives, an interrupt is raised, and the core uses the driver to poll the Rx ring. Now, since the core is already handling this ring, why pause it by raising another interrupt? So the interrupt for this ring is turned off until the ring is empty. Once the ring is empty, it is turned back on. This is the NAPI system.

Each call to the poll function takes up to 64 packets (i think). If it took all 64, there may be more, so the interrupt stays off and the ring stays on the poll list. If it took less than 64, the ring is empty, so the interrupt goes back on.

This work is called the softirq. It normally does not run in its own thread. This core runs it itself, right after the interrupt, and whatever was running on this core is paused.

### 5. The budget

The core cannot keep handling network packets all day long, because it has other tasks as well. So there is a budget. Handle at most 300 packets, or run for a limited time, and then stop, even if packets are left.

If there is work left, core 3 retries for a short while. If there is still work left, it wakes up a thread called `ksoftirqd`, and that thread does the rest. Since it is a normal thread, the scheduler can make it take turns with the other programs on the core. There is one `ksoftirqd` per core, created at boot. The interrupt stays off during all this.

### 6. Building the skb

The driver's poll code, running on the core, builds the skb. It only has pointers to the DMA'd packet bytes, not the data, so there is no copy. (the skb can wrap the buffer directly.)

The driver also refills the ring. It writes a new/available-for-use buffer's address into the used descriptors, and tells the NIC that they are free again. It does this in batches. If the driver never refilled, the NIC would run out of free descriptors and drop packets, no matter how fast the core is.

### 7. GRO

Before going up the stack, the kernel can merge several packets of the same flow into one big skb. This is GRO, generic receive offload. The rest of the stack then runs only once for all of them.

For a plain UDP socket this is not done by default. 10 datagrams means 10 skbs. The program has to turn on `UDP_GRO` on its socket (some device settings can also do it).

### 8. RPS, if it is on

RPS is receive packet steering, and it is off by default. The polling is still done by core A, this work can't leave core A. But after the skb is built, core A hashes the packet's flow, picks another core, say core B, places the skb in core B's backlog queue, and interrupts core B. Then core B does the rest of the work.

Distribution depends heavily on what is being hashed. With only one flow, every packet gets the same hash, so only one core does the IP and UDP work.

In the rest of this post RPS is off, so core A does everything.

### 9. IP and UDP

A packet is an ethernet header, followed by an IP header, followed by a UDP header, followed by the actual data. The kernel checks each header, and then moves the skb's pointer past it. The header is not really removed, only the pointer moves.

- **IP** checks the header, runs the iptables rules, and checks the route, to see if the packet is for this machine.
- **UDP** looks at the port, and finds the socket.

### 10. The socket receive queue

Every socket has a receive queue. Core A puts the skb in it, and wakes up the calling thread. The socket is not on any core. It is in kernel memory, which is shared and not per core. So core 3 can find it and write to it, even though our program is on core another core.

### 11. The copy

Core B starts running my thread again, still inside `recv()`. It picks up the skb from the queue, and copies the data from the kernel to my buffer in user space. Then the skb is freed, which makes room in the queue.

The DMA is done by the NIC, so the CPU copies the data only once, here. If my buffer is smaller than the datagram, the rest of the datagram is lost.

## Where packets can get dropped

| place                         | why                                                                            | who drops it                                    | where to look                                        |
| ----------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------- |
| Rx ring                       | no free descriptor, because packets arrive faster than the core can drain them | the NIC                                         | `ethtool -S`, the counter name depends on the driver |
| backlog queue (only with RPS) | more than about 1000 skbs waiting                                              | the core doing the steering (core A)            | `/proc/net/softnet_stat`                             |
| IP                            | bad header, or an iptables rule drops it                                       | the core doing IP                               | `/proc/net/snmp`, iptables counters                  |
| UDP, no socket                | no program has opened the port. It also sends back an ICMP port unreachable    | the core doing UDP                              | `NoPorts` in `/proc/net/snmp`                        |
| UDP, bad checksum             | the data is corrupted                                                          | the core doing UDP, or `recv()` during the copy | `InCsumErrors` in `/proc/net/snmp`                   |
| socket receive queue          | `recv()` is not called fast enough, or the queue is full                       | core 3, not core 5                              | `RcvbufErrors` in `/proc/net/snmp`                   |

These are connected. If core A is slowed down by something, like a lot of slow iptables rules, it cannot pick up packets from the Rx ring quickly, so packets start getting dropped at the ring.

## Tuning

Every setting here helps with some problem and not others. So first find where the packets are being dropped.

- **Socket buffer size.** If the socket queue is full, increase it with `SO_RCVBUF`, up to `net.core.rmem_max`. The default is `net.core.rmem_default`. The limit is in bytes, and the skb struct and buffer count too, not only the data. This helps with bursts. It does not help if `recv()` is always too slow.
- **Ring size.** If the Rx ring fills up, see `ethtool -g eth0`, and increase it with `ethtool -G eth0 rx 4096`. This also only helps with bursts.
- **RSS.** More rings means more cores can poll. Set it with `ethtool -L`. Some NICs hash only the IPs for UDP. See it with `ethtool -n eth0 rx-flow-hash udp4`, and add ports with `ethtool -N eth0 rx-flow-hash udp4 sdfn`, if the NIC allows it. It does not help with a single flow.
- **RPS.** Useful when the NIC has too few rings. Set it in `/sys/class/net/eth0/queues/rx-0/rps_cpus`. It spreads the work after polling. Polling stays on the same core, and a single flow still goes to one core.
- **Backlog size.** `net.core.netdev_max_backlog`. Only matters if RPS is on, or the driver uses the old `netif_rx`.
- **IRQ affinity.** Choose which core a ring's interrupt goes to, with `/proc/irq/<number>/smp_affinity`. `irqbalance` can overwrite it, so turn that off or exclude the IRQ.
- **Pinning and isolation.** IRQ affinity does not move my program. If the kernel moves my thread to another core, there is context switch and cache miss overhead. So pin the thread to a core, and isolate the core, so the kernel does not put other work on it. It is also better to keep the Rx ring's core and the program on the same NUMA node.
- **Interrupt coalescing.** The NIC waits for some time, or for a number of packets, before raising an interrupt. Set with `ethtool -C` (`rx-usecs`, `rx-frames`). Fewer interrupts means more throughput and less CPU, but more latency. More interrupts is the opposite. This is not the same thing as NAPI.
- **NAPI budget.** `net.core.netdev_budget`, 300 by default. If `time_squeeze` in `/proc/net/softnet_stat` keeps growing, the budget or the time limit is running out with work left. Increasing it means more work per round, and other programs on that core wait longer.
- **iptables rules.** Every rule is run for every packet, on the core doing IP. Keep them few.
- **UDP_GRO.** If datagrams of a flow come in bursts, turn on `UDP_GRO` on the socket, so the stack runs once for many of them.
- **recvmmsg.** Get many datagrams in one system call, instead of one `recv()` per datagram.
- **SO_REUSEPORT.** Open several sockets on the same port, each with its own receive queue, so many threads don't fight over the lock of one queue.

## Sources

- [packagecloud: receiving data](https://blog.packagecloud.io/monitoring-tuning-linux-networking-stack-receiving-data/)
- [packagecloud: illustrated guide, receiving](https://blog.packagecloud.io/illustrated-guide-monitoring-tuning-linux-networking-stack-receiving-data)
- [Cloudflare: how to receive a million packets](https://blog.cloudflare.com/how-to-receive-a-million-packets)
